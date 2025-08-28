import crypto from 'crypto';
import {logMessage} from "./logger.js";

// AES-256-CBC algorithm and key/iv values (should be from your .env or configuration)
const algorithm = 'aes-256-cbc';

/**
 * Encrypts a given plaintext string using AES-256-CBC encryption.
 *
 * @param {string} text - The plaintext string to be encrypted.
 * @param {string} key - The encryption key (32 bytes).
 * @param {string} iv - The initialization vector (16 bytes).
 * @returns {Promise<string>} The encrypted text in hexadecimal format.
 */
async function encryptText(text, key, iv) {
    try {
        // Ensure key and iv are buffers and properly sized
        const keyBuffer = Buffer.from(key, 'hex');  // Convert hex key to buffer
        const ivBuffer = Buffer.from(iv, 'hex');   // Convert hex IV to buffer

        if (keyBuffer.length !== 32 || ivBuffer.length !== 16) {
            throw new Error('Invalid key or IV length. AES-256-CBC requires a 32-byte key and a 16-byte IV.');
        }

        const cipher = crypto.createCipheriv(algorithm, keyBuffer, ivBuffer);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (error) {
        logMessage('error', 'crypto encryptText', error)
    }
}

/**
 * Decrypts a given encrypted Base64 string using AES-256-CBC decryption.
 *
 * @param {string} encryptedData - The encrypted data in Base64 format.
 * @param {string} key - The decryption key (32 bytes).
 * @param {string} iv - The initialization vector (16 bytes).
 * @returns {Promise<string>} The decrypted plaintext string.
 */
async function decryptText(encryptedData, key, iv) {
    try {
        // Ensure key and iv are buffers and properly sized
        const keyBuffer = Buffer.from(key, 'hex');  // Convert hex key to buffer
        const ivBuffer = Buffer.from(iv, 'hex');   // Convert hex IV to buffer

        if (keyBuffer.length !== 32 || ivBuffer.length !== 16) {
            throw new Error('Invalid key or IV length. AES-256-CBC requires a 32-byte key and a 16-byte IV.');
        }

        // If the encrypted data is Base64-encoded (as it is from the .env file), decode it first
        const encryptedDataBuffer = Buffer.from(encryptedData, 'base64');  // Decode Base64 to Buffer

        const decipher = crypto.createDecipheriv(algorithm, keyBuffer, ivBuffer);
        let decrypted = decipher.update(encryptedDataBuffer, null, 'utf8');  // Decrypt the Buffer data
        decrypted += decipher.final('utf8');  // Finalize the decryption
        return decrypted;  // Return the decrypted plaintext string
    } catch (error) {
        logMessage('error', 'crypto decryptText', error);
        throw error; // Re-throw the error after logging it
    }
}


/**
 * Generates a secure AES-256-CBC key and IV.
 *
 * @returns {Object} An object containing the `key` and `iv` in hexadecimal format.
 */
function generateCryptoKeyAndIV() {
    const key = crypto.randomBytes(32);  // 32 bytes for AES-256
    const iv = crypto.randomBytes(16);   // 16 bytes for IV

    return {
        CRYPTO_KEY: key.toString('hex'),
        CRYPTO_IV: iv.toString('hex')
    };
}

export { encryptText, decryptText, generateCryptoKeyAndIV };
