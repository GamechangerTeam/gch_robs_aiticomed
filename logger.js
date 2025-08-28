import fs from "fs";
import path from "path";

// Логирование сообщений в файл
export function logMessage(type, source, messageOrError) {
  try {
    const currentTime = new Date().toLocaleString();
    const isError = type === "error";
    const typeLabel = isError
      ? "[ERROR]"
      : type === "info"
      ? "[INFO]"
      : type === "warn"
      ? "[WARNING]"
      : "[ACCESS]";
    const messageContent = isError
      ? `Error: ${messageOrError?.stack || messageOrError}`
      : `${messageOrError}`;

    const formattedMessage = `${currentTime} ${typeLabel} - Source: ${source}\n${messageContent}\n\n`;

    const logsDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFileName = `logs_${formatDate(new Date())}.log`;
    const logFilePath = path.join(logsDir, logFileName);

    fs.appendFileSync(logFilePath, formattedMessage);

    console.log(`${currentTime} ${typeLabel} ${source} - ${messageContent}`);
  } catch (error) {
    console.error("Unexpected logging error:", error);
  }
}

// Форматирование даты
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
