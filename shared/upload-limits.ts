/** Shared by chat selection and assets transport to enforce the same upload budget. */
export const CHAT_UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Maximum attachments in one chat message. */
export const CHAT_UPLOAD_MAX_FILES = 10;
/** Bounds the combined payload buffered by the Cockpit bridge. */
export const CHAT_UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
