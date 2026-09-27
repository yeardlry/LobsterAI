/**
 * English identity — used for on-disk paths (userData directory,
 * migration rollback roots) so user data never lands in a
 * Chinese-named directory.
 */
export const APP_NAME = 'LiteratureAI';
/**
 * Localized display name — window title, macOS menu bar (must match the
 * packaged productName so `<productName> Helper.app` resolution in
 * coworkUtil keeps working), and default productName for builds.
 */
export const APP_DISPLAY_NAME = '文献智能助手';
export const APP_ID = 'literatureai';
export const APP_USER_MODEL_ID = 'com.literatureai.app';
export const APP_ATTENTION_BADGE_COLOR = '#FF3B30';
export const DB_FILENAME = 'lobsterai.sqlite';
