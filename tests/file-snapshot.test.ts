import { describe, expect, test } from "bun:test";
import { FolderChangingError, scanWhileFolderSettles } from "../client/src/lib/fileSnapshot";

const changed = () => new DOMException("An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.", "InvalidStateError");
const noWait = async () => undefined;

describe("reading a connected folder that is changing", () => {
  test("scans again until the folder holds still", async () => {
    let scans = 0;
    const result = await scanWhileFolderSettles("Vault", async () => {
      scans += 1;
      if (scans < 3) throw changed();
      return "files";
    }, noWait);
    expect(result).toBe("files");
    expect(scans).toBe(3);
  });

  test("names the folder instead of showing the browser's raw message when it never settles", async () => {
    let scans = 0;
    const error = await scanWhileFolderSettles("margin-chat-vault", async () => { scans += 1; throw changed(); }, noWait).catch((caught) => caught);
    expect(error).toBeInstanceOf(FolderChangingError);
    expect(error.message).toContain("“margin-chat-vault”");
    expect(error.message).not.toContain("state cached in an interface object");
    expect(scans).toBe(5);
  });

  test("does not retry other failures", async () => {
    let scans = 0;
    const missing = new DOMException("gone", "NotFoundError");
    await expect(scanWhileFolderSettles("Vault", async () => { scans += 1; throw missing; }, noWait)).rejects.toBe(missing);
    expect(scans).toBe(1);
  });
});
