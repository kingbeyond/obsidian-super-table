import { App, Modal, Notice, TFile } from "obsidian";
import { t } from "./i18n";
import { node as el, control, icon } from "./ui";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);
function attachmentName(path: string): string { return path.split("/").filter(Boolean).at(-1) ?? path; }
function isImage(path: string): boolean { return IMAGE_EXTENSIONS.has(path.split(".").at(-1)?.toLowerCase() ?? ""); }
export function attachmentIcon(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (isImage(path)) return "image";
  if (extension === "pdf") return "file-text";
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extension)) return "music-2";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(extension)) return "film";
  return "file";
}

export interface AttachmentPanelState { scrollTop: number; removeIndex?: number; focusAdd?: boolean }
export interface AttachmentCellController {
  open(state?: AttachmentPanelState): void; close(): void; destroy(): void;
  panelState(): AttachmentPanelState | null;
}

export function renderAttachmentCell(options: {
  app: App; cell: HTMLTableCellElement; paths: string[]; sourcePath: string;
  add: (state?: AttachmentPanelState) => Promise<void>; remove: (index: number) => Promise<unknown>; report: (error: unknown) => void;
}): AttachmentCellController {
  const { app, cell, paths, sourcePath } = options;
  const doc = cell.ownerDocument;
  const win = doc.defaultView;
  let panel: HTMLDivElement | null = null;
  let preview: Modal | null = null;
  let destroyed = false;
  let removingIndex: number | undefined;
  const compact = el("div", "tb-attachments");
  const findFile = (path: string) => {
    const file = app.vault?.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  };
  const thumbnail = (path: string, file: TFile | null): HTMLElement => {
    const wrap = el("span", "tb-attachment-thumbnail");
    if (!file || !isImage(path)) { wrap.append(icon(file ? attachmentIcon(path) : "file-warning")); return wrap; }
    const image = el("img", "tb-attachment-preview");
    image.alt = file.name; image.loading = "lazy"; image.decoding = "async";
    image.onerror = () => { image.onerror = null; wrap.replaceChildren(icon("image-off")); };
    image.src = app.vault.getResourcePath(file);
    wrap.append(image);
    return wrap;
  };
  paths.slice(0, 3).forEach((path, index) => {
    const file = findFile(path);
    const tile = thumbnail(path, file);
    tile.classList.toggle("is-missing", !file);
    if (file && isImage(path)) {
      const button = control("", undefined, "tb-attachment-direct");
      button.setAttribute("aria-label", t("Open {name}", { name: file.name }));
      button.append(tile);
      button.onclick = (event) => {
        event.preventDefault(); event.stopPropagation();
        close(); showImage(file, button, index);
      };
      compact.append(button);
    } else {
      tile.setAttribute("aria-label", file ? file.name : t("File not found: {path}", { path }));
      compact.append(tile);
    }
  });
  if (paths.length > 3) compact.append(el("span", "tb-attachment-more", `+${paths.length - 3}`));
  cell.append(compact);
  cell.setAttribute("aria-label", t("{count} attachments", { count: paths.length }));
  cell.setAttribute("aria-haspopup", "dialog"); cell.setAttribute("aria-expanded", "false");

  function position(): void {
    if (!panel) return;
    if (!cell.isConnected) { close(); return; }
    const rect = cell.getBoundingClientRect();
    const viewport = win?.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 16;
    const topEdge = (viewport?.offsetTop ?? 0) + 16;
    const rightEdge = leftEdge + Math.max(0, (viewport?.width ?? win?.innerWidth ?? 800) - 32);
    const bottomEdge = topEdge + Math.max(0, (viewport?.height ?? win?.innerHeight ?? 600) - 32);
    panel.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`;
    const maxHeight = Math.max(0, Math.min(600, bottomEdge - topEdge));
    panel.style.maxHeight = `${maxHeight}px`;
    const headingHeight = panel.querySelector<HTMLElement>(".tb-attachment-panel-heading")?.getBoundingClientRect().height ?? 24;
    const addHeight = panel.querySelector<HTMLElement>(".tb-attachment-add")?.getBoundingClientRect().height ?? 32;
    // A very short viewport needs one scroll area instead of a collapsed file list.
    panel.classList.toggle("is-height-constrained", maxHeight < headingHeight + addHeight + 66 + 56);
    const size = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(leftEdge, Math.min(rect.left, rightEdge - size.width))}px`;
    const below = rect.bottom + 8;
    const top = below + size.height <= bottomEdge ? below : rect.top - size.height - 8;
    panel.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - size.height))}px`;
  }
  function close(restoreFocus = false): void {
    panel?.remove(); panel = null;
    cell.setAttribute("aria-expanded", "false"); cell.removeAttribute("aria-controls");
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("focusin", outsideFocus);
    doc.removeEventListener("keydown", escape, true);
    win?.removeEventListener("resize", position);
    win?.removeEventListener("scroll", position, true);
    win?.visualViewport?.removeEventListener("resize", position);
    win?.visualViewport?.removeEventListener("scroll", position);
    if (restoreFocus && !destroyed && cell.isConnected) cell.focus({ preventScroll: true });
  }
  function outside(event: Event): void {
    if (preview) return;
    const target = event.target as Node | null;
    if (target && !cell.contains(target) && !panel?.contains(target)) close();
  }
  function outsideFocus(event: Event): void { outside(event); }
  function escape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || preview) return;
    event.preventDefault(); event.stopPropagation(); close(true);
  }
  function showImage(file: TFile, returnTo: HTMLElement, attachmentIndex: number): void {
    if (preview || destroyed || !cell.isConnected) return;
    const imageEntries: Array<{ file: TFile; attachmentIndex: number }> = [];
    paths.forEach((path, index) => {
      const imageFile = isImage(path) ? findFile(path) : null;
      if (imageFile) imageEntries.push({ file: imageFile, attachmentIndex: index });
    });
    if (!imageEntries.some((entry) => entry.attachmentIndex === attachmentIndex)) {
      imageEntries.unshift({ file, attachmentIndex });
    }
    let currentIndex = Math.max(0, imageEntries.findIndex((entry) => entry.attachmentIndex === attachmentIndex));
    class ImagePreview extends Modal {
      private detachPreviewListeners?: () => void;
      private previewBackdrop: HTMLElement | null = null;

      onOpen(): void {
        const currentFile = () => imageEntries[currentIndex].file;
        this.setTitle(currentFile().name);
        this.modalEl.classList.add("tb-image-preview-modal");
        const modalContainer = this.modalEl.closest<HTMLElement>(".modal-container") ?? this.containerEl;
        this.previewBackdrop = modalContainer.querySelector<HTMLElement>(".modal-bg");
        this.previewBackdrop?.classList.add("tb-image-preview-backdrop");
        this.contentEl.classList.add("tb-image-preview-content");
        const title = this.modalEl.querySelector<HTMLElement>(".modal-title");
        const closeButton = this.modalEl.querySelector<HTMLElement>(".modal-close-button");
        if (title && title.parentElement !== this.modalEl) {
          const modalContent = this.modalEl.querySelector<HTMLElement>(".modal-content");
          const insertionPoint = closeButton?.parentElement === this.modalEl
            ? closeButton
            : modalContent?.parentElement === this.modalEl ? modalContent : null;
          this.modalEl.insertBefore(title, insertionPoint);
        }
        const titleText = title ? el("span", "tb-image-preview-title-text", currentFile().name) : null;
        if (title && titleText) title.replaceChildren(titleText);
        const image = el("img", "tb-image-preview-image"); image.alt = currentFile().name;
        image.draggable = false;
        const failure = el("p", "tb-image-preview-error", t("Could not load image.")); failure.hidden = true;
        const stage = el("div", "tb-image-preview-stage");
        const canvas = el("div", "tb-image-preview-canvas");
        canvas.append(image);
        stage.append(canvas, failure);
        let zoom = 1;
        const zoomLevel = el("span", "tb-image-preview-zoom-level", "100%");
        zoomLevel.setAttribute("aria-live", "polite");
        const iconButton = (glyph: string, label: string, className: string) => {
          const button = control("", undefined, className);
          const setContents = (nextGlyph: string, nextLabel: string) => {
            button.removeAttribute("aria-label"); button.removeAttribute("title");
            button.replaceChildren(icon(nextGlyph, "tb-control-icon"), el("span", "tb-sr-only", nextLabel));
          };
          setContents(glyph, label);
          return { button, setContents };
        };
        const previous = iconButton("chevron-left", t("Previous image"), "tb-image-preview-previous").button;
        const imageCount = el("span", "tb-image-preview-count");
        imageCount.setAttribute("aria-live", "polite");
        const next = iconButton("chevron-right", t("Next image"), "tb-image-preview-next").button;
        const navigation = el("div", "tb-image-preview-navigation");
        navigation.append(previous, imageCount, next);
        const divider = el("span", "tb-image-preview-divider"); divider.setAttribute("aria-hidden", "true");
        const zoomOut = iconButton("zoom-out", t("Zoom out"), "tb-image-preview-zoom-out").button;
        const zoomIn = iconButton("zoom-in", t("Zoom in"), "tb-image-preview-zoom-in").button;
        const fit = iconButton("move-diagonal", t("Fit image"), "tb-image-preview-fit").button;
        const expandControl = iconButton("maximize", t("Expand preview"), "tb-image-preview-expand");
        const expand = expandControl.button;
        const toolbar = el("div", "tb-image-preview-toolbar");
        // Hidden button text supplies accessible names without Obsidian's aria-label hover bubbles.
        toolbar.append(navigation, divider, zoomOut, zoomLevel, zoomIn, fit, expand);
        let panX = 0;
        let panY = 0;
        let hasCustomPan = false;
        let activePointer: number | null = null;
        let pointerStartX = 0;
        let pointerStartY = 0;
        let panStartX = 0;
        let panStartY = 0;
        let dragging = false;
        let suppressClick = false;
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
        const updateImagePosition = () => {
          if (!image.naturalWidth || !image.naturalHeight) return;
          const width = Number.parseFloat(image.style.width) || image.naturalWidth;
          const height = Number.parseFloat(image.style.height) || image.naturalHeight;
          const stageWidth = stage.clientWidth;
          const stageHeight = stage.clientHeight;
          const minX = Math.min(0, stageWidth - width);
          const minY = Math.min(0, stageHeight - height);
          const left = width <= stageWidth ? (stageWidth - width) / 2 : clamp(hasCustomPan ? panX : (stageWidth - width) / 2, minX, 0);
          const top = height <= stageHeight ? (stageHeight - height) / 2 : clamp(hasCustomPan ? panY : (stageHeight - height) / 2, minY, 0);
          panX = left;
          panY = top;
          image.style.left = `${left}px`;
          image.style.top = `${top}px`;
          const canPan = width > stageWidth || height > stageHeight;
          image.style.cursor = dragging ? "grabbing" : canPan ? "grab" : zoom > 1 ? "zoom-out" : "zoom-in";
          stage.classList.toggle("is-draggable", canPan);
        };
        const updateImageSize = () => {
          zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
          zoomOut.disabled = zoom <= 0.25;
          zoomIn.disabled = zoom >= 8;
          if (!image.naturalWidth || !image.naturalHeight) return;
          const fitScale = Math.min(1, stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight);
          const width = Math.max(1, Math.round(image.naturalWidth * fitScale * zoom));
          const height = Math.max(1, Math.round(image.naturalHeight * fitScale * zoom));
          image.style.width = `${width}px`;
          image.style.height = `${height}px`;
          updateImagePosition();
        };
        const updatePreviewWidth = () => {
          if (!image.naturalWidth || !image.naturalHeight) return;
          if (!win || win.innerWidth <= 600 || this.modalEl.classList.contains("is-expanded")) {
            this.modalEl.style.removeProperty("width");
            return;
          }
          const stageHeight = stage.clientHeight;
          if (stageHeight <= 0) return;
          const modalWidth = this.modalEl.getBoundingClientRect().width;
          const horizontalChrome = Math.max(0, modalWidth - stage.clientWidth);
          const heightFitScale = Math.min(1, stageHeight / image.naturalHeight);
          const fittedImageWidth = image.naturalWidth * heightFitScale;
          const toolbarStyle = win.getComputedStyle(toolbar);
          const gap = Number.parseFloat(toolbarStyle.columnGap || toolbarStyle.gap) || 0;
          const toolbarWidth = Array.from(toolbar.children).reduce(
            (width, child) => width + child.getBoundingClientRect().width,
            0,
          ) + gap * Math.max(0, toolbar.children.length - 1);
          const maxWidth = Math.min(1120, win.innerWidth - 32);
          const desiredWidth = Math.min(maxWidth, Math.max(fittedImageWidth, toolbarWidth) + horizontalChrome);
          this.modalEl.style.width = `${Math.ceil(desiredWidth)}px`;
        };
        const updatePreviewLayout = () => {
          updatePreviewWidth();
          updateImageSize();
        };
        const setZoom = (next: number) => {
          zoom = Math.max(0.25, Math.min(8, next));
          hasCustomPan = false;
          updateImageSize();
        };
        const updateNavigation = () => {
          imageCount.textContent = `${currentIndex + 1} / ${imageEntries.length}`;
          previous.disabled = currentIndex <= 0;
          next.disabled = currentIndex >= imageEntries.length - 1;
        };
        const setCurrentImage = (nextIndex: number) => {
          currentIndex = Math.max(0, Math.min(imageEntries.length - 1, nextIndex));
          const nextFile = currentFile();
          this.setTitle(nextFile.name);
          if (title && titleText) title.replaceChildren(titleText);
          if (titleText) titleText.textContent = nextFile.name;
          this.contentEl.setAttribute("aria-label", nextFile.name);
          image.alt = nextFile.name;
          image.hidden = true;
          failure.hidden = true;
          image.style.removeProperty("width"); image.style.removeProperty("height");
          image.style.removeProperty("left"); image.style.removeProperty("top");
          zoom = 1; panX = 0; panY = 0; hasCustomPan = false; dragging = false; activePointer = null;
          zoomLevel.textContent = "100%";
          zoomOut.disabled = false; zoomIn.disabled = false;
          updateNavigation();
          image.src = app.vault.getResourcePath(nextFile);
        };
        zoomOut.onclick = () => setZoom(zoom / 1.25);
        zoomIn.onclick = () => setZoom(zoom * 1.25);
        fit.onclick = () => setZoom(1);
        previous.onclick = () => setCurrentImage(currentIndex - 1);
        next.onclick = () => setCurrentImage(currentIndex + 1);
        image.addEventListener("click", (event) => {
          if (suppressClick) { event.preventDefault(); suppressClick = false; return; }
          setZoom(zoom > 1 ? 1 : 2);
        });
        image.onload = () => { image.hidden = false; failure.hidden = true; updatePreviewLayout(); };
        image.onerror = () => { image.hidden = true; failure.hidden = false; };
        const pointerDown = (event: PointerEvent) => {
          if (event.button !== 0 || !image.naturalWidth || !image.naturalHeight) return;
          const width = Number.parseFloat(image.style.width) || 0;
          const height = Number.parseFloat(image.style.height) || 0;
          if (width <= stage.clientWidth && height <= stage.clientHeight) return;
          activePointer = event.pointerId ?? 1;
          pointerStartX = event.clientX;
          pointerStartY = event.clientY;
          panStartX = Number.parseFloat(image.style.left) || 0;
          panStartY = Number.parseFloat(image.style.top) || 0;
          dragging = false;
          try { stage.setPointerCapture(activePointer); } catch { /* Pointer capture is not available in every test or embedded view. */ }
        };
        const pointerMove = (event: PointerEvent) => {
          if (activePointer === null || (event.pointerId ?? 1) !== activePointer) return;
          const deltaX = event.clientX - pointerStartX;
          const deltaY = event.clientY - pointerStartY;
          if (!dragging && Math.hypot(deltaX, deltaY) < 3) return;
          dragging = true;
          hasCustomPan = true;
          panX = panStartX + deltaX;
          panY = panStartY + deltaY;
          event.preventDefault();
          updateImagePosition();
        };
        const pointerUp = (event: PointerEvent) => {
          if (activePointer === null || (event.pointerId ?? 1) !== activePointer) return;
          activePointer = null;
          if (dragging) {
            suppressClick = true;
            win?.setTimeout(() => { suppressClick = false; }, 0);
          }
          dragging = false;
          updateImagePosition();
        };
        const pointerCancel = () => {
          activePointer = null;
          dragging = false;
          updateImagePosition();
        };
        image.addEventListener("pointerdown", pointerDown);
        stage.addEventListener("pointermove", pointerMove);
        stage.addEventListener("pointerup", pointerUp);
        stage.addEventListener("pointercancel", pointerCancel);
        const zoomWithWheel = (event: WheelEvent) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          setZoom(zoom * (event.deltaY < 0 ? 1.25 : 1 / 1.25));
        };
        stage.addEventListener("wheel", zoomWithWheel, { passive: false });
        win?.addEventListener("resize", updatePreviewLayout);
        const toggleExpanded = () => {
          const isExpanded = this.modalEl.classList.toggle("is-expanded");
          const label = t(isExpanded ? "Restore preview" : "Expand preview");
          expandControl.setContents(isExpanded ? "minimize" : "maximize", label);
          updatePreviewLayout();
        };
        const isTitleBar = (event: MouseEvent) => {
          const modalRect = this.modalEl.getBoundingClientRect();
          const contentTop = this.contentEl.getBoundingClientRect().top;
          return event.clientX >= modalRect.left && event.clientX <= modalRect.right
            && event.clientY >= modalRect.top && event.clientY < contentTop;
        };
        const eventTargetElement = (event: MouseEvent) => {
          const target = event.target as Node | null;
          return target?.nodeType === 1 ? target as Element : target?.parentElement;
        };
        const isCloseButton = (event: MouseEvent) => Boolean(eventTargetElement(event)?.closest(".modal-close-button"));
        const isFilename = (event: MouseEvent) => {
          if (!titleText) return false;
          const rect = titleText.getBoundingClientRect();
          return event.clientX >= rect.left && event.clientX <= rect.right
            && event.clientY >= rect.top && event.clientY <= rect.bottom;
        };
        const preventBlankTitleSelection = (event: MouseEvent) => {
          if (!isTitleBar(event) || isCloseButton(event) || isFilename(event)) return;
          event.preventDefault();
        };
        const doubleClickTitleBar = (event: MouseEvent) => {
          if (!isTitleBar(event) || isCloseButton(event) || isFilename(event)) return;
          event.preventDefault();
          toggleExpanded();
        };
        this.modalEl.addEventListener("mousedown", preventBlankTitleSelection);
        this.modalEl.addEventListener("dblclick", doubleClickTitleBar);
        this.detachPreviewListeners = () => {
          stage.removeEventListener("wheel", zoomWithWheel);
          image.removeEventListener("pointerdown", pointerDown);
          stage.removeEventListener("pointermove", pointerMove);
          stage.removeEventListener("pointerup", pointerUp);
          stage.removeEventListener("pointercancel", pointerCancel);
          win?.removeEventListener("resize", updatePreviewLayout);
          this.modalEl.removeEventListener("mousedown", preventBlankTitleSelection);
          this.modalEl.removeEventListener("dblclick", doubleClickTitleBar);
        };
        expand.onclick = toggleExpanded;
        this.contentEl.append(stage, toolbar);
        updateNavigation();
        image.src = app.vault.getResourcePath(currentFile());
      }
      onClose(): void {
        this.previewBackdrop?.classList.remove("tb-image-preview-backdrop");
        this.previewBackdrop = null;
        this.detachPreviewListeners?.();
        this.detachPreviewListeners = undefined;
        // Native Modal restores focus after onClose. Defer until that finishes,
        // keeping outside-focus dismissal suspended throughout the transition.
        // Keep the guard for the rest of the native key/pointer event as well;
        // microtasks can run between document listeners for the same event.
        win?.setTimeout(() => {
          if (preview !== this) return;
          if (!destroyed) (returnTo.isConnected ? returnTo : cell).focus({ preventScroll: true });
          preview = null;
        }, 0);
      }
    }
    preview = new ImagePreview(app); preview.open();
  }
  function open(state?: AttachmentPanelState): void {
    if (panel || destroyed || !cell.isConnected) return;
    panel = el("div", "tablebase-root tb-ui-surface tb-attachment-popover");
    panel.id = `tb-attachments-${++panelSequence}`;
    panel.setAttribute("role", "dialog");
    const heading = el("div", "tb-attachment-panel-heading");
    const count = el("span", "tb-attachment-count", t("{count} attachments", { count: paths.length }));
    count.id = `${panel.id}-count`; panel.setAttribute("aria-labelledby", count.id);
    const nameControl = (button: HTMLButtonElement, name: string, suffix: string) => {
      const label = el("span", "tb-sr-only", name); label.id = `${panel!.id}-${suffix}`;
      button.removeAttribute("aria-label"); button.setAttribute("aria-labelledby", label.id); button.append(label);
    };
    const done = control("", "x", "tb-icon-button tb-attachment-close");
    nameControl(done, t("Close attachments"), "close");
    done.onclick = () => close(true);
    heading.append(count, done);
    const list = el("div", "tb-attachment-panel-list");
    if (!paths.length) list.append(el("p", "tb-attachment-empty", t("No attachments.")));
    paths.forEach((path, index) => {
      const file = findFile(path);
      const name = file?.name ?? attachmentName(path);
      const row = el("div", "tb-attachment-panel-row");
      const button = control("", undefined, `tb-attachment-open${file ? "" : " is-missing"}`);
      nameControl(button, file ? t("Open {name}", { name }) : t("File not found: {path}", { path }), `open-${index}`);
      button.disabled = !file;
      button.append(thumbnail(path, file), el("span", "tb-attachment-name", name));
      if (!file) row.append(el("span", "tb-attachment-missing", t("File not found: {path}", { path })));
      button.onclick = () => {
        if (!file) return;
        if (isImage(path)) showImage(file, button, index);
        else { close(); void app.workspace.openLinkText(path, sourcePath).catch(options.report); }
      };
      const remove = control("", "x", "tb-icon-button tb-attachment-remove");
      nameControl(remove, t("Remove {name}", { name }), `remove-${index}`);
      remove.onclick = async () => {
        removingIndex = index;
        remove.disabled = true;
        cell.focus({ preventScroll: true });
        try { await options.remove(index); } catch (error) { options.report(error); }
        finally { remove.disabled = false; removingIndex = undefined; }
      };
      row.prepend(button); row.append(remove); list.append(row);
    });
    const add = control(t("Add attachment"), "plus", "tb-attachment-add");
    add.removeAttribute("aria-label");
    add.onclick = () => {
      const state = panel ? { scrollTop: list.scrollTop, focusAdd: true } : undefined;
      close(true);
      void options.add(state).catch(options.report);
    };
    panel.append(heading, list, add);
    cell.setAttribute("aria-expanded", "true"); cell.setAttribute("aria-controls", panel.id);
    doc.body.append(panel);
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("focusin", outsideFocus);
    doc.addEventListener("keydown", escape, true);
    win?.addEventListener("resize", position);
    win?.addEventListener("scroll", position, true);
    win?.visualViewport?.addEventListener("resize", position);
    win?.visualViewport?.addEventListener("scroll", position);
    position();
    if (state) list.scrollTop = state.scrollTop;
    const removes = list.querySelectorAll<HTMLButtonElement>(".tb-attachment-remove");
    const focus = state?.focusAdd ? add : state?.removeIndex !== undefined
      ? removes[Math.min(state.removeIndex, removes.length - 1)] ?? add
      : list.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? add;
    focus.focus({ preventScroll: true });
  }
  return {
    open, close,
    panelState: () => panel ? {
      scrollTop: panel.querySelector<HTMLElement>(".tb-attachment-panel-list")?.scrollTop ?? 0,
      removeIndex: removingIndex,
    } : null,
    destroy() { destroyed = true; close(); preview?.close(); preview = null; },
  };
}

let panelSequence = 0;
