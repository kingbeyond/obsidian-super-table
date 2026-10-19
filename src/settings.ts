export type AttachmentImagePasteLocation = "obsidian" | "note-folder";

export interface SuperTableSettings {
  attachmentImagePasteLocation: AttachmentImagePasteLocation;
}

export const DEFAULT_SETTINGS: SuperTableSettings = {
  attachmentImagePasteLocation: "obsidian",
};

export function normalizeSuperTableSettings(value: unknown): SuperTableSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    attachmentImagePasteLocation: raw.attachmentImagePasteLocation === "note-folder" ? "note-folder" : "obsidian",
  };
}

export function noteNamedAttachmentFolder(sourcePath: string): string {
  const segments = sourcePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const noteFile = segments.pop() ?? "Untitled.md";
  const extension = noteFile.lastIndexOf(".");
  const noteName = extension > 0 ? noteFile.slice(0, extension) : noteFile;
  return [...segments, "附件", noteName || "Untitled"].join("/");
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/svg+xml": "svg",
};

export function pastedImageFileName(name: string, mimeType: string, timestamp = Date.now()): string {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  const extension = IMAGE_EXTENSIONS[mime];
  const basename = name.replace(/\\/g, "/").split("/").at(-1) ?? "";
  let safeName = basename.trim().replace(/[\u0000-\u001f<>:"|?*]/g, "_");
  if (!safeName || safeName === "." || safeName === "..") {
    return `pasted-image-${timestamp}${extension ? `.${extension}` : ""}`;
  }
  if (!/\.[^.]+$/.test(safeName) && extension) safeName += `.${extension}`;
  return safeName;
}

export function attachmentFileNameWithSuffix(fileName: string, suffix: number): string {
  if (suffix <= 0) return fileName;
  const dot = fileName.lastIndexOf(".");
  const hasExtension = dot > 0;
  const base = hasExtension ? fileName.slice(0, dot) : fileName;
  const extension = hasExtension ? fileName.slice(dot) : "";
  return `${base} ${suffix}${extension}`;
}
