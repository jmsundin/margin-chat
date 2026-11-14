import { HttpError } from "../lib/errors.mjs";

/** Interface settings are a handful of short strings; this is far more than they need. */
export const INTERFACE_SETTINGS_BODY_LIMIT = 64 * 1024;
const MAX_SETTINGS = 60;
const MAX_VALUE = 4000;
/** The client's own setting names, such as "margin-chat:features" or "margin-chat-theme". */
const SETTING_NAME = /^margin-chat[:-][a-z0-9][a-z0-9:-]{0,62}$/;

function readChanges(body) {
  const values = body && typeof body === "object" ? body.values : null;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new HttpError(400, "Send settings as { values: { name: text } }.");
  const entries = Object.entries(values);
  if (entries.length > MAX_SETTINGS) throw new HttpError(413, `Send at most ${MAX_SETTINGS} settings at a time.`);
  for (const [name, value] of entries) {
    if (!SETTING_NAME.test(name)) throw new HttpError(400, `“${name.slice(0, 80)}” isn't a Margin Chat setting.`);
    if (value !== null && (typeof value !== "string" || value.length > MAX_VALUE)) throw new HttpError(400, `The setting ${name} must be text of at most ${MAX_VALUE} characters.`);
  }
  return Object.fromEntries(entries);
}

/** How a person has set up their interface, kept on the account so every device opens the same way. */
export function createInterfaceSettingsService({ database }) {
  async function read({ userId }) {
    return { values: await database.readInterfaceSettings({ userId }) };
  }
  async function save({ userId, body }) {
    const changes = readChanges(body);
    const current = await database.readInterfaceSettings({ userId });
    const names = new Set(Object.keys(current));
    for (const [name, value] of Object.entries(changes)) value === null ? names.delete(name) : names.add(name);
    if (names.size > MAX_SETTINGS) throw new HttpError(413, `An account keeps at most ${MAX_SETTINGS} interface settings.`);
    return { values: await database.saveInterfaceSettings({ userId, changes }) };
  }
  return { read, save };
}
