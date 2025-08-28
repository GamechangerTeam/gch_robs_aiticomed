// server.mjs
import "dotenv/config";
import express from "express";
import axios from "axios";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";

// утилиты из проекта
import { encryptText, decryptText, generateCryptoKeyAndIV } from "./crypto.js";
import { logMessage } from "./logger.js";

const app = express();
app.use(express.json());

// Базовый префикс и порт
const BASE_URL = process.env.BASE_URL || "/gch_robs_itcomed";
const PORT = Number(process.env.PORT || 5682);

// Хардкоды по требованиям
const HARD_RESPONSIBLE_ID = 1; // обязательный для документа
const HARD_CURRENCY = "KZT"; // обязательный для документа

// ==== rate limit для /init ====
const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// =================== Bitrix REST helpers ===================

/** Получить расшифрованную ссылку вебхука Bitrix (в .env хранится base64-шифртекст) */
async function getBxBaseUrlFromEnv() {
  const { CRYPTO_KEY, CRYPTO_IV, BX_LINK } = process.env;
  if (!CRYPTO_KEY || !CRYPTO_IV || !BX_LINK) {
    throw new Error("Bitrix вебхук не инициализирован. Вызовите /init.");
  }
  return decryptText(BX_LINK, CRYPTO_KEY, CRYPTO_IV);
}

/** Вызов REST Bitrix с улучшенной ошибкой */
async function bxCall(method, params = {}) {
  const baseUrl = await getBxBaseUrlFromEnv(); // https://<portal>/rest/<user>/<token>
  const url = `${baseUrl}/${method}.json`;
  try {
    const { data } = await axios.post(url, params);
    if (data?.error) {
      throw new Error(
        `${method}: ${data.error} - ${data.error_description || ""}`
      );
    }
    return data.result;
  } catch (e) {
    if (e.response?.data) {
      const ed = e.response.data;
      throw new Error(
        `${method}: ${ed.error || e.message} - ${ed.error_description || ""}`
      );
    }
    throw e;
  }
}

/** Пагинация list-методов по полю "next" */
async function bxListAll(method, baseParams = {}, itemsKey = "items") {
  const params = { ...baseParams, start: 0 };
  let out = [];
  let resp = await bxCall(method, params);
  console.log(resp);
  out = out.concat(resp?.[itemsKey] || []);
  while (typeof resp?.next !== "undefined") {
    params.start = resp.next;
    resp = await bxCall(method, params);
    out = out.concat(resp?.[itemsKey] || []);
  }
  return out;
}

// =================== CRM helpers ===================

/** Валидируем/нормализуем короткий ownerType */
function normalizeOwnerTypeShort(v) {
  if (!v) return null;
  const u = String(v).toUpperCase().trim();
  if (u === "D") return "D"; // Сделка
  if (/^DYNAMIC_\d+$/.test(u)) return u; // Смарт-процесс
  throw new Error("ownerType должен быть 'D' или 'DYNAMIC_<id>'");
}

/** ownerTypeShort из elemType+spaTypeId (для обратной совместимости) */
function resolveOwnerTypeShort(elemType, spaTypeId) {
  const t = String(elemType || "").toUpperCase();
  if (t === "D") return "D"; // Сделка
  if (t === "S")
    return `DYNAMIC_${Number(
      spaTypeId || process.env.SPA_ENTITY_TYPE_ID || 1068
    )}`;
  throw new Error("elemType должен быть S (смарт-процесс) или D (сделка)");
}

/** entityTypeId из ownerTypeShort */
function entityTypeIdFromOwnerShort(ownerShort) {
  if (ownerShort === "D") return 2; // Сделка
  const m = /^DYNAMIC_(\d+)$/.exec(ownerShort || "");
  return m ? Number(m[1]) : null;
}

/** Документный тип: принимаем только S/M/D и передаём как есть */
function mapDocTypeToBitrix(rawDocType) {
  const c = String(rawDocType || "").toUpperCase();
  if (c === "S" || c === "M" || c === "D") return c;
  throw new Error(
    "docType должен быть S (оприходование), M (перемещение) или D (списание)"
  );
}

/** Товарные строки элемента */
async function getProductRows(ownerTypeShort, elemId) {
  const params = {
    filter: { "=ownerType": ownerTypeShort, "=ownerId": Number(elemId) },
    select: ["*"],
  };
  console.log("getProductRows params:", params);
  return bxListAll("crm.item.productrow.list", params, "productRows");
}

/** Прочитать сам элемент (для авто-получения складов при M) */
async function getItem(ownerTypeShort, elemId) {
  const entityTypeId = entityTypeIdFromOwnerShort(ownerTypeShort);
  if (!entityTypeId)
    throw new Error("Не удалось определить entityTypeId для элемента");
  const res = await bxCall("crm.item.get", {
    entityTypeId,
    id: Number(elemId),
  });
  return res?.item || {};
}

// =================== Складские документы ===================

/** Создать документ складского учёта (используем docType, а не type) */
async function createDocument(bitrixDocType, title, { siteId } = {}) {
  const fields = {
    docType: bitrixDocType, // S | M | D
    title: title || `Auto ${bitrixDocType}`,
    responsibleId: HARD_RESPONSIBLE_ID,
    currency: HARD_CURRENCY,
    date: new Date().toISOString(),
    ...(siteId ? { siteId } : {}),
  };
  return bxCall("catalog.document.add", { fields }); // вернёт id
}

/** Добавить строки в документ (catalog.document.element.add) */
async function addRowsToDocument(
  docId,
  bitrixDocType,
  rows,
  { storeId, storeFrom, storeTo }
) {
  const tasks = [];

  for (const r of rows) {
    const productId = Number(r.PRODUCT_ID || r.productId);
    const quantity = Number(r.QUANTITY || r.quantity || 0);
    if (!productId || !quantity) continue;

    const fields = { docId, elementId: productId, amount: quantity };

    if (bitrixDocType === "S") {
      // оприходование — нужен целевой склад
      if (!storeId && !storeTo)
        throw new Error("Для docType=S нужен storeId (или storeTo)");
      fields.storeTo = Number(storeTo || storeId);
    } else if (bitrixDocType === "D") {
      // списание — нужен склад-источник
      if (!storeId && !storeFrom)
        throw new Error("Для docType=D нужен storeId (или storeFrom)");
      fields.storeFrom = Number(storeFrom || storeId);
    } else if (bitrixDocType === "M") {
      // перемещение — оба склада обязательны
      if (!storeFrom || !storeTo)
        throw new Error("Для docType=M нужны storeFrom и storeTo");
      fields.storeFrom = Number(storeFrom);
      fields.storeTo = Number(storeTo);
    }

    tasks.push(bxCall("catalog.document.element.add", { fields }));
  }

  await Promise.all(tasks);
}

// =================== /init ===================

app.post(BASE_URL + "/init", limiter, async (req, res) => {
  try {
    const bxLink = req.body.bx_link;
    if (!bxLink) {
      res.status(400).json({
        status: false,
        status_msg: "error",
        message: "Необходимо предоставить ссылку входящего вебхука!",
      });
      return;
    }

    const keyIv = generateCryptoKeyAndIV();
    const bxLinkEncrypted = await encryptText(
      bxLink,
      keyIv.CRYPTO_KEY,
      keyIv.CRYPTO_IV
    );

    // Сохраняем base64 от hex-шифртекста
    const bxLinkEncryptedBase64 = Buffer.from(bxLinkEncrypted, "hex").toString(
      "base64"
    );

    const envPath = path.resolve(process.cwd(), ".env");
    const envContent =
      `CRYPTO_KEY=${keyIv.CRYPTO_KEY}\n` +
      `CRYPTO_IV=${keyIv.CRYPTO_IV}\n` +
      `BX_LINK=${bxLinkEncryptedBase64}\n`;

    fs.writeFileSync(envPath, envContent, "utf8");

    // Без перезапуска:
    process.env.CRYPTO_KEY = keyIv.CRYPTO_KEY;
    process.env.CRYPTO_IV = keyIv.CRYPTO_IV;
    process.env.BX_LINK = bxLinkEncryptedBase64;

    res.status(200).json({
      status: true,
      status_msg: "success",
      message: "Система готова работать с вашим битриксом!",
    });
  } catch (error) {
    logMessage("error", BASE_URL + "/init", error);
    res.status(500).json({
      status: false,
      status_msg: "error",
      message: "Server error",
    });
  }
});

// =================== /process_docs ===================

app.post(BASE_URL + "/process_docs", async (req, res) => {
  try {
    const {
      elemId, // ID элемента
      docType, // S (оприходование) | M (перемещение) | D (списание)

      // склады
      storeId, // для S/D
      storeFrom,
      storeTo, // для M

      // идентификация владельца товарных строк
      ownerType, // 'D' или 'DYNAMIC_<id>' (приоритетнее)
      ownerTypeShort, // синоним к ownerType
      elemType, // S | D (используется, если не пришёл ownerType и нет spaTypeId)
      spaTypeId, // ID смарт-процесса (entityTypeId SPA)
      entityTypeId,
      smartTypeId,

      // опции
      conduct = "true",
      dryRun = "false",
      storeFromField,
      storeToField,
      siteId,
    } = req.query;

    if (!elemId) return res.status(400).json({ error: "elemId обязателен" });
    if (!docType)
      return res.status(400).json({ error: "docType обязателен (S|M|D)" });

    // 1) Определяем ownerTypeShort
    let ownerShort = null;

    // a) явный ownerType / ownerTypeShort
    if (ownerType || ownerTypeShort) {
      try {
        ownerShort = normalizeOwnerTypeShort(ownerType || ownerTypeShort);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // b) ID смарт-процесса → DYNAMIC_<id>
    if (!ownerShort) {
      const spaIdRaw = spaTypeId ?? entityTypeId ?? smartTypeId;
      if (spaIdRaw != null && spaIdRaw !== "") {
        const spaId = Number(spaIdRaw);
        if (!Number.isFinite(spaId) || spaId <= 0) {
          return res.status(400).json({
            error:
              "spaTypeId/entityTypeId/smartTypeId должен быть положительным числом",
          });
        }
        ownerShort = `DYNAMIC_${spaId}`;
      }
    }

    // c) старый путь — из elemType
    if (!ownerShort) {
      if (!elemType)
        return res.status(400).json({
          error:
            "elemType обязателен (S|D), если не указан ownerType или spaTypeId",
        });
      ownerShort = resolveOwnerTypeShort(
        elemType,
        spaTypeId ?? entityTypeId ?? smartTypeId
      );
    }

    const bitrixDocType = mapDocTypeToBitrix(docType);

    // 2) Строгие проверки складов по типу
    if (bitrixDocType === "S") {
      if (!(storeId || storeTo)) {
        return res
          .status(400)
          .json({ error: "Для docType=S нужен storeId (или storeTo)" });
      }
      if (storeFrom) {
        return res.status(400).json({
          error:
            "Для docType=S не используйте storeFrom. Для перемещения — docType=M.",
        });
      }
    } else if (bitrixDocType === "D") {
      if (!(storeId || storeFrom)) {
        return res
          .status(400)
          .json({ error: "Для docType=D нужен storeId (или storeFrom)" });
      }
      if (storeTo) {
        return res.status(400).json({
          error:
            "Для docType=D не используйте storeTo. Для перемещения — docType=M.",
        });
      }
    }

    // 3) Товарные строки
    console.log(`Получаем товарные позиции для ${ownerShort} #${elemId}...`);
    const rows = await getProductRows(ownerShort, elemId);
    console.log(`Найдено товарных позиций: ${rows.length}`);
    if (!rows.length) {
      return res.status(404).json({
        error: "У элемента нет товарных позиций",
        elemId: Number(elemId),
        ownerTypeShort: ownerShort,
      });
    }

    // 4) Склады
    let resolvedStoreId = storeId ? Number(storeId) : null;
    let resolvedStoreFrom = storeFrom ? Number(storeFrom) : null;
    let resolvedStoreTo = storeTo ? Number(storeTo) : null;

    // Перемещение: если не хватает склада — добираем из полей элемента
    if (bitrixDocType === "M" && (!resolvedStoreFrom || !resolvedStoreTo)) {
      const item = await getItem(ownerShort, elemId);

      if (!resolvedStoreFrom) {
        if (storeFromField && item?.[storeFromField] != null) {
          resolvedStoreFrom = Number(item[storeFromField]) || null;
        } else {
          resolvedStoreFrom =
            Number(
              item?.UF_STORE_FROM ??
                item?.UF_WAREHOUSE_FROM ??
                item?.UF_CRM_STORE_FROM
            ) || null;
        }
      }
      if (!resolvedStoreTo) {
        if (storeToField && item?.[storeToField] != null) {
          resolvedStoreTo = Number(item[storeToField]) || null;
        } else {
          resolvedStoreTo =
            Number(
              item?.UF_STORE_TO ??
                item?.UF_WAREHOUSE_TO ??
                item?.UF_CRM_STORE_TO
            ) || null;
        }
      }

      if (!resolvedStoreFrom || !resolvedStoreTo) {
        return res.status(400).json({
          error:
            "Для docType=M нужны оба склада (storeFrom & storeTo). Передайте их в query или укажите storeFromField/storeToField.",
          got: { storeFrom: resolvedStoreFrom, storeTo: resolvedStoreTo },
        });
      }
    }

    // 5) dry-run
    if (String(dryRun).toLowerCase() === "true") {
      return res.json({
        dryRun: true,
        elemId: Number(elemId),
        ownerTypeShort: ownerShort,
        docTypeIncoming: String(docType).toUpperCase(),
        bitrixDocType,
        responsibleId: HARD_RESPONSIBLE_ID,
        currency: HARD_CURRENCY,
        rows: rows.map((r) => ({
          productId: Number(r.PRODUCT_ID),
          quantity: Number(r.QUANTITY || 0),
        })),
        stores:
          bitrixDocType === "S"
            ? { storeTo: Number(resolvedStoreId ?? resolvedStoreTo) }
            : bitrixDocType === "D"
            ? { storeFrom: Number(resolvedStoreId ?? resolvedStoreFrom) }
            : {
                storeFrom: Number(resolvedStoreFrom),
                storeTo: Number(resolvedStoreTo),
              },
      });
    }

    console.log("Создаём документ...");
    // 6) создать документ → 7) добавить позиции → 8) провести
    const docId = (
      await createDocument(
        bitrixDocType,
        `Auto ${bitrixDocType} from ${ownerShort} #${elemId}`,
        { siteId }
      )
    ).document.id;
    console.log(`Документ #${docId} создан. Добавляем позиции...`);

    await addRowsToDocument(docId, bitrixDocType, rows, {
      storeId: resolvedStoreId,
      storeFrom: resolvedStoreFrom,
      storeTo: resolvedStoreTo,
    });

    let conducted = false;
    if (String(conduct).toLowerCase() === "true") {
      conducted = await bxCall("catalog.document.conduct", { id: docId });
    }

    return res.json({
      ok: true,
      docId,
      conducted: Boolean(conducted),
      rowsAdded: rows.length,
    });
  } catch (error) {
    logMessage("error", BASE_URL + "/process_docs", error);
    return res.status(500).json({ error: error.message || String(error) });
  }
});

// =================== start ===================
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}${BASE_URL}`);
});
