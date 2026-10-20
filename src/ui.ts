import { t } from "./i18n";
import { App, Menu, MenuItem, Modal, setIcon } from "obsidian";
import { FieldType } from "./model";

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = createEl(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function icon(name: string, className = ""): HTMLSpanElement {
  const element = node("span", className);
  setIcon(element, name);
  return element;
}

export function control(label: string, glyph?: string, className = ""): HTMLButtonElement {
  const element = node("button", `tb-button ${className}`);
  element.type = "button";
  element.setAttribute("aria-label", label);
  if (glyph) element.append(icon(glyph, "tb-control-icon"));
  if (label) element.append(node("span", "", label));
  return element;
}

export const fieldIcon: Record<FieldType, string> = {
  text: "text", link: "link", number: "hash", date: "calendar", datetime: "calendar-clock",
  checkbox: "check-square", select: "chevron-down-circle", multiselect: "tags", attachment: "paperclip", status: "circle-dot",
};

export function configMenuItem(item: MenuItem, label: string, glyph?: string): MenuItem {
  const title = createFragment();
  title.append(node("span", "tb-config-menu-label", label));
  // Pass content icons here and keep each menu uniform: sections affect host ordering and separators.
  if (glyph) item.setIcon(glyph);
  return item.setSection(glyph ? "super-table-config-icon" : "super-table-config").setTitle(title);
}

export function menuAction(menu: Menu, label: string, glyph: string, action: () => unknown, disabled = false, warning = false): void {
  menu.addItem((item) => item.setTitle(label).setIcon(glyph).setDisabled(disabled).setWarning(warning).onClick(action));
}

export function submenu(menu: Menu, label: string, glyph: string, populate: (child: Menu) => void, trackFallback?: (child: Menu) => void): void {
  menu.addItem((item) => {
    item.setTitle(label).setIcon(glyph);
    // Some Obsidian releases expose submenu support without declaring it in the public types.
    const create = (item as MenuItem & { setSubmenu?: () => Menu }).setSubmenu;
    if (create) populate(create.call(item));
    else item.onClick((event) => {
      const child = new Menu();
      populate(child);
      trackFallback?.(child);
      if (event instanceof MouseEvent) child.showAtMouseEvent(event);
      else child.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    });
  });
}

export function showMenu(menu: Menu, anchor: HTMLElement, event?: MouseEvent, onHide?: () => void): void {
  const ownerDocument = anchor.ownerDocument;
  let hidden = false;
  const finish = () => {
    if (hidden) return;
    hidden = true;
    ownerDocument.removeEventListener("pointerdown", dismissOnOutsidePointerDown, true);
    onHide?.();
  };
  const dismissOnOutsidePointerDown = (pointerEvent: PointerEvent) => {
    const target = pointerEvent.target;
    if (target instanceof Element && (anchor.contains(target) || target.closest(".menu"))) return;
    menu.hide();
    finish();
  };
  // Compose caller cleanup and listener cleanup into one Obsidian Menu hide hook.
  menu.onHide(finish);
  ownerDocument.addEventListener("pointerdown", dismissOnOutsidePointerDown, true);

  // A native right-click normally has detail === 0, unlike a pointer click.
  const pointerContextMenu = event?.type === "contextmenu" &&
    (event.button === 2 || event.clientX !== 0 || event.clientY !== 0);
  if (event && (event.detail > 0 || pointerContextMenu)) menu.showAtMouseEvent(event);
  else {
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, ownerDocument);
  }
}

export interface FormField { label: string; value?: string; type?: string; description?: string; options?: Array<{ value: string; label: string }> }

export interface PromptFormOptions {
  modalClassName?: string;
  hideSingleFieldLabel?: boolean;
}

let formAccessibilityTextSequence = 0;

function bindVisibleActionLabel(button: HTMLButtonElement): void {
  const label = button.querySelector(":scope > span:not(.tb-control-icon)");
  if (!(label instanceof HTMLSpanElement)) return;
  label.id = `tb-dialog-action-${++formAccessibilityTextSequence}`;
  button.removeAttribute("aria-label");
  button.setAttribute("aria-labelledby", label.id);
}

export function promptForm(app: App, title: string, fields: FormField[], submitLabel = t("Save"), options: PromptFormOptions = {}): Promise<string[] | null> {
  return new Promise((resolve) => {
    class FormModal extends Modal {
      result: string[] | null = null;
      onOpen(): void {
        if (options.modalClassName) {
          this.modalEl.classList.add("tb-ui-surface", options.modalClassName);
        }
        this.setTitle(title);
        this.contentEl.classList.add("tb-dialog");
        const form = node("form");
        const inputs: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = [];
        const hideSingleFieldLabel = options.hideSingleFieldLabel && fields.length === 1;
        fields.forEach((field) => {
          const hideLabel = hideSingleFieldLabel;
          const label = node(hideLabel ? "div" : "label", "tb-dialog-field", hideLabel ? undefined : field.label);
          let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          if (field.options) {
            const select = node("select", "tb-input");
            field.options.forEach((choice) => {
              const option = node("option", "", choice.label); option.value = choice.value; select.append(option);
            });
            input = select;
          } else if (field.type === "textarea") input = node("textarea", "tb-input");
          else { input = node("input", "tb-input"); input.type = field.type || "text"; }
          input.value = field.value ?? "";
          if (hideLabel) {
            const accessibleLabel = node("span", "tb-sr-only", field.label);
            accessibleLabel.id = `tb-dialog-label-${++formAccessibilityTextSequence}`;
            input.setAttribute("aria-labelledby", accessibleLabel.id);
            label.append(accessibleLabel);
          } else {
            input.setAttribute("aria-label", field.label);
          }
          inputs.push(input); label.append(input);
          if (field.description) {
            const description = node("div", "tb-dialog-help", field.description);
            description.id = `tb-dialog-help-${++formAccessibilityTextSequence}`;
            input.setAttribute("aria-describedby", description.id);
            label.append(description);
          }
          form.append(label);
        });
        const actions = node("div", "tb-dialog-actions");
        const cancel = control(t("Cancel"));
        const submit = control(submitLabel); submit.type = "submit"; submit.classList.add("mod-cta");
        if (hideSingleFieldLabel) {
          bindVisibleActionLabel(cancel);
          bindVisibleActionLabel(submit);
        }
        cancel.onclick = () => this.close();
        actions.append(cancel, submit); form.append(actions);
        form.onsubmit = (event) => { event.preventDefault(); this.result = inputs.map((input) => input.value); this.close(); };
        this.contentEl.append(form);
        inputs[0]?.focus();
      }
      onClose(): void { resolve(this.result); }
    }
    new FormModal(app).open();
  });
}

export function confirmDialog(app: App, title: string, message: string, actionLabel = t("Continue")): Promise<boolean> {
  return new Promise((resolve) => {
    class ConfirmModal extends Modal {
      confirmed = false;
      onOpen(): void {
        this.modalEl.classList.add("tb-ui-surface", "tb-confirm-modal");
        this.setTitle(title);
        this.contentEl.append(node("p", "tb-dialog-message", message));
        const actions = node("div", "tb-dialog-actions");
        const cancel = control(t("Cancel"));
        bindVisibleActionLabel(cancel);
        cancel.onclick = () => this.close();
        const submit = control(actionLabel); submit.classList.add("mod-warning");
        bindVisibleActionLabel(submit);
        submit.onclick = () => { this.confirmed = true; this.close(); };
        actions.append(cancel, submit); this.contentEl.append(actions);
      }
      onClose(): void { resolve(this.confirmed); }
    }
    new ConfirmModal(app).open();
  });
}
