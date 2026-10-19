const MAX_PREVIEWS = 128;
const MAX_PREVIEW_LENGTH = 16_384;
const PASSIVE_TAGS = new Set(["P", "A", "SPAN", "STRONG", "B", "EM", "I", "S", "DEL", "CODE", "BR", "MARK", "SUP", "SUB"]);
const previews = new WeakMap<object, WeakMap<Document, Map<string, DocumentFragment>>>();

function cacheFor(owner: object, doc: Document): Map<string, DocumentFragment> {
  let documents = previews.get(owner);
  if (!documents) { documents = new WeakMap(); previews.set(owner, documents); }
  let cache = documents.get(doc);
  if (!cache) { cache = new Map(); documents.set(doc, cache); }
  return cache;
}

export function markdownPreviewCache(owner: object, doc: Document, sourcePath: string) {
  const cache = cacheFor(owner, doc);
  return {
    restore(source: string, content: HTMLElement): boolean {
      if (source.length > MAX_PREVIEW_LENGTH) return false;
      const key = JSON.stringify([sourcePath, source]);
      const preview = cache.get(key);
      if (!preview) return false;
      cache.delete(key); cache.set(key, preview);
      content.replaceChildren(preview.cloneNode(true));
      return true;
    },
    remember(source: string, rendered: HTMLElement): void {
      if (source.length > MAX_PREVIEW_LENGTH || !rendered.firstElementChild || rendered.innerHTML.length > MAX_PREVIEW_LENGTH) return;
      // Reading view may recreate the fenced block after a save. Reuse only passive
      // inline output while Obsidian renders again; embeds, tasks and internal links
      // need fresh components and must never be restored as inert DOM copies.
      const elements = [...rendered.querySelectorAll<HTMLElement>("*")];
      if (elements.some((element) => !PASSIVE_TAGS.has(element.tagName)
        || element.hasAttribute("id") || element.hasAttribute("contenteditable")
        || element.classList.contains("internal-link")
        || element.tagName === "A" && !/^https?:\/\//i.test(element.getAttribute("href") ?? ""))) return;
      const key = JSON.stringify([sourcePath, source]);
      const preview = doc.adoptNode(createFragment());
      rendered.childNodes.forEach((child) => preview.append(child.cloneNode(true)));
      cache.delete(key); cache.set(key, preview);
      if (cache.size > MAX_PREVIEWS) cache.delete(cache.keys().next().value!);
    },
  };
}
