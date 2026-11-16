import { protocolContentBytes, type ProtocolDirectoryEntry } from "@ovst/protocol";

/** The text an entry holds as a placement writes it: a file's bytes, or a page as its Markdown file. Undefined when it holds neither or its object is missing. */
export function entryText(entry: ProtocolDirectoryEntry | undefined, objects: { get(hash: string): Uint8Array | undefined }): string | undefined {
  const hash = entry?.file ?? entry?.page;
  const bytes = hash ? objects.get(hash) : undefined;
  return bytes ? new TextDecoder().decode(protocolContentBytes(entry!.page ? "page" : "file", bytes)) : undefined;
}
