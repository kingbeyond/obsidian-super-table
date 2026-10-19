import { Menu, Platform } from "obsidian";
import { t } from "./i18n";
import type { MessageKey } from "./locales/en";
import { makeId } from "./model";
import type { Field } from "./model";
import { filterDateKind, filterNeedsValue, filterOperators, validFilterCondition } from "./filters";
import type { FilterCondition, FilterGroup, FilterOperator } from "./filters";
import { configMenuTitle, control, fieldIcon, icon, node, showMenu } from "./ui";

export interface FilterSession {
  trigger(): HTMLButtonElement | null;
  snapshot(viewId: string): { fields: Field[]; filters: FilterGroup } | null;
  save(viewId: string, change: (filters: FilterGroup) => void): Promise<boolean>;
}
interface SelectOption { value: string; label: string; icon?: string }
interface Draft {
  rule: FilterCondition;
  baseline?: string;
  dirty: boolean;
  saving: Set<string>;
  failed: boolean;
  lastSubmitted?: string;
  element?: HTMLElement;
}
const sessions = new Map<string, FilterSession>();
const popovers = new Map<string, FilterPopover>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const fingerprint = (rule: FilterCondition) => JSON.stringify(rule);
const operatorLabels: Record<FilterOperator, MessageKey> = {
  eq: "Equals", neq: "Does not equal", contains: "Contains", notContains: "Does not contain",
  gt: "Greater than", gte: "Greater than or equal to", lt: "Less than", lte: "Less than or equal to",
  between: "Between", isEmpty: "Is empty", isNotEmpty: "Is not empty", checked: "Checked", unchecked: "Unchecked",
};
function nameControl(element: HTMLElement, text: string): void {
  const label = node("span", "tb-sr-only", text);
  label.id = makeId("tb-filter-label");
  const selected = element.querySelector<HTMLElement>(".tb-filter-select-label");
  if (selected) selected.id = makeId("tb-filter-selected");
  element.setAttribute("aria-labelledby", [label.id, selected?.id].filter(Boolean).join(" "));
  // Labels live beside inputs, since inputs and native selects cannot contain label nodes.
  element.insertAdjacentElement("beforebegin", label);
}

export function attachFilterSession(key: string, session: FilterSession): () => void {
  const document = session.trigger()?.ownerDocument ?? globalThis.document;
  sessions.set(key, session);
  popovers.get(key)?.refresh();
  return () => {
    if (sessions.get(key) !== session) return;
    sessions.delete(key);
    // A note save can replace its renderer. Allow the new controller to rebind first.
    document.defaultView?.setTimeout(() => {
      if (!sessions.has(key)) popovers.get(key)?.close();
    }, 250);
  };
}
export function refreshFilterPopover(key: string): void { popovers.get(key)?.refresh(); }
export function closeFilterPopover(key: string): void { popovers.get(key)?.close(); }
export function toggleFilterPopover(key: string, viewId: string, trigger: HTMLButtonElement): void {
  const existing = popovers.get(key);
  if (existing) { existing.close(true); return; }
  const popover = new FilterPopover(key, viewId, trigger);
  popovers.set(key, popover);
  popover.open();
}

class FilterPopover {
  panel = node("div", "tablebase-root tb-dialog tb-ui-surface tb-filter-popover");
  list = node("div", "tb-filter-conditions");
  mode!: HTMLSelectElement | HTMLButtonElement;
  modeOptions = [{ value: "and", label: t("Meet all conditions") }, { value: "or", label: t("Meet any condition") }];
  clear = control(t("Clear filters"), "filter-x", "tb-filter-clear");
  drafts: Draft[] = [];
  closed = false;
  picker: { panel: HTMLElement; draft: Draft; trigger: HTMLButtonElement; search: HTMLInputElement; draw(): void } | null = null;
  selectMenu: { menu: Menu; draft?: Draft; trigger: HTMLButtonElement } | null = null;
  hostDismissedMenu: { trigger: HTMLButtonElement } | null = null;
  lastFilters = "";
  saveQueue: Promise<boolean> = Promise.resolve(true);

  constructor(readonly key: string, readonly viewId: string, readonly initialTrigger: HTMLButtonElement) {}
  session(): FilterSession | undefined { return sessions.get(this.key); }
  snapshot() { return this.session()?.snapshot(this.viewId); }
  trigger(): HTMLButtonElement | null { return this.session()?.trigger() ?? (this.initialTrigger.isConnected ? this.initialTrigger : null); }

  open(): void {
    const doc = this.initialTrigger.ownerDocument;
    this.panel.id = makeId("tb-filter-popover"); this.panel.tabIndex = -1;
    this.panel.setAttribute("role", "dialog");
    const header = node("div", "tb-filter-header");
    const title = node("h2", "tb-filter-title", t("Set filter conditions")); title.id = makeId("tb-filter-title");
    this.panel.setAttribute("aria-labelledby", title.id);
    this.mode = this.selector("tb-filter-mode", () => this.modeOptions, "and", (value) => {
      void this.save((filters) => { filters.mode = value as FilterGroup["mode"]; }).then((saved) => {
        if (!saved) this.setSelectorValue(this.mode, this.snapshot()?.filters.mode ?? "and", this.modeOptions);
      });
    });
    const modeWrap = node("div", "tb-filter-select-wrap tb-filter-mode-wrap");
    modeWrap.append(this.mode, icon("chevron-down", "tb-filter-select-chevron"));
    header.append(title, modeWrap); nameControl(this.mode, t("Condition relationship"));
    const close = control("", "x", "tb-icon-button tb-filter-close");
    header.append(close); close.removeAttribute("aria-label"); nameControl(close, t("Close filter settings"));
    close.onclick = () => this.close(true);
    const actions = node("div", "tb-filter-actions");
    const add = control(t("Add condition"), "plus", "tb-filter-add");
    add.onclick = () => this.add();
    this.clear.onclick = () => {
      this.closePicker(); this.closeSelectMenu();
      void this.save((filters) => { filters.conditions = []; }).then((saved) => {
        if (!saved || this.closed) return;
        this.drafts = []; this.drawRows();
      });
    };
    actions.append(add, this.clear); this.panel.append(header, this.list, actions);
    add.removeAttribute("aria-label"); this.clear.removeAttribute("aria-label");
    doc.body.append(this.panel);
    doc.addEventListener("pointerdown", this.outside, true);
    doc.addEventListener("keydown", this.keydown, true);
    doc.defaultView?.addEventListener("resize", this.position);
    doc.defaultView?.addEventListener("scroll", this.position, true);
    doc.defaultView?.visualViewport?.addEventListener("resize", this.position);
    doc.defaultView?.visualViewport?.addEventListener("scroll", this.position);
    this.refresh(); this.panel.focus({ preventScroll: true });
  }

  close(restoreFocus = false): void {
    if (this.closed) return;
    this.closed = true; this.closePicker(); this.closeSelectMenu(); this.hostDismissedMenu = null;
    const doc = this.panel.ownerDocument;
    doc.removeEventListener("pointerdown", this.outside, true);
    doc.removeEventListener("keydown", this.keydown, true);
    doc.defaultView?.removeEventListener("resize", this.position);
    doc.defaultView?.removeEventListener("scroll", this.position, true);
    doc.defaultView?.visualViewport?.removeEventListener("resize", this.position);
    doc.defaultView?.visualViewport?.removeEventListener("scroll", this.position);
    if (popovers.get(this.key) === this) popovers.delete(this.key);
    const trigger = this.trigger();
    trigger?.setAttribute("aria-expanded", "false"); trigger?.removeAttribute("aria-controls");
    trigger?.classList.toggle("is-active", !!this.snapshot()?.filters.conditions.length);
    this.panel.remove();
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }
  outside = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && (this.panel.contains(target) || this.trigger()?.contains(target) || this.picker?.panel.contains(target))) return;
    if (this.selectMenu && target instanceof Element && target.closest(".menu")) return;
    this.close();
  };
  keydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (this.selectMenu) this.closeSelectMenu(true);
    else if (this.picker) this.closePicker(true);
    else if (this.hostDismissedMenu) {
      const trigger = this.hostDismissedMenu.trigger; this.hostDismissedMenu = null;
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    } else this.close(true);
  };
  position = (): void => {
    if (this.closed) return;
    if (this.selectMenu && !this.selectMenu.trigger.isConnected) this.closeSelectMenu();
    const anchor = this.trigger(); if (!anchor?.isConnected) return;
    const win = this.panel.ownerDocument.defaultView;
    const viewport = win?.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0; const topEdge = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? win?.innerWidth ?? 1024; const height = viewport?.height ?? win?.innerHeight ?? 768;
    this.panel.style.maxWidth = `${Math.max(0, width - 32)}px`;
    this.panel.style.maxHeight = `${Math.max(0, height - 32)}px`;
    for (const kind of ["date", "datetime-local", "time"]) {
      this.panel.classList.toggle(`has-${kind}-range`, !!this.list.querySelector(`.tb-filter-range[data-kind="${kind}"]`));
    }
    const fixedHeight = (this.panel.querySelector(".tb-filter-header")?.getBoundingClientRect().height || 32)
      + (this.panel.querySelector(".tb-filter-actions")?.getBoundingClientRect().height || 32) + 64;
    this.panel.classList.toggle("is-short-viewport", height - 32 < fixedHeight + 80);
    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    const panelWidth = panelRect.width || Math.min(560, width - 32);
    const panelHeight = panelRect.height || 180;
    const left = Math.max(leftEdge + 16, Math.min(rect.left, leftEdge + width - panelWidth - 16));
    const below = rect.bottom + 8;
    const top = Math.max(topEdge + 16, Math.min(below + panelHeight > topEdge + height - 16 ? rect.top - panelHeight - 8 : below, topEdge + height - panelHeight - 16));
    this.panel.style.left = `${Math.round(left)}px`; this.panel.style.top = `${Math.round(top)}px`;
    if (this.picker) {
      const valueRect = this.picker.trigger.getBoundingClientRect();
      const picker = this.picker.panel;
      picker.style.width = `${Math.max(0, Math.min(Math.max(valueRect.width, 240), width - 32))}px`;
      picker.style.maxHeight = `${Math.max(0, height - 32)}px`;
      const naturalHeight = picker.getBoundingClientRect().height || 240;
      const belowSpace = Math.max(0, topEdge + height - 16 - valueRect.bottom - 8);
      const aboveSpace = Math.max(0, valueRect.top - topEdge - 16 - 8);
      const openAbove = naturalHeight > belowSpace && aboveSpace > belowSpace;
      picker.style.maxHeight = `${Math.max(0, Math.min(height - 32, Math.max(80, openAbove ? aboveSpace : belowSpace)))}px`;
      const pickerRect = picker.getBoundingClientRect();
      picker.style.left = `${Math.max(leftEdge + 16, Math.min(valueRect.left, leftEdge + width - (pickerRect.width || 240) - 16))}px`;
      const pickerTop = openAbove ? valueRect.top - pickerRect.height - 8 : valueRect.bottom + 8;
      picker.style.top = `${Math.max(topEdge + 16, Math.min(pickerTop, topEdge + height - pickerRect.height - 16))}px`;
    }
  };

  refresh(): void {
    if (this.closed) return;
    const snapshot = this.snapshot(); if (!snapshot) { if (this.session()) this.close(); return; }
    this.trigger()?.setAttribute("aria-expanded", "true"); this.trigger()?.setAttribute("aria-controls", this.panel.id);
    this.trigger()?.classList.add("is-active");
    this.setSelectorValue(this.mode, snapshot.filters.mode, this.modeOptions);
    const serialized = JSON.stringify(snapshot.filters);
    if (serialized !== this.lastFilters) {
      this.lastFilters = serialized;
      const byId = new Map(snapshot.filters.conditions.map((rule) => [rule.id, rule]));
      for (const draft of [...this.drafts]) {
        const saved = byId.get(draft.rule.id);
        if (saved) {
          const stored = fingerprint(saved);
          if (!draft.dirty && !draft.saving.size && draft.baseline !== stored) {
            draft.rule = clone(saved); draft.baseline = stored; this.drawRow(draft);
          }
          byId.delete(saved.id);
        } else if (draft.baseline && !draft.dirty && !draft.saving.size) {
          draft.element?.remove(); this.drafts.splice(this.drafts.indexOf(draft), 1);
        }
      }
      for (const rule of byId.values()) {
        const draft: Draft = { rule: clone(rule), baseline: fingerprint(rule), dirty: false, saving: new Set(), failed: false };
        this.drafts.push(draft); this.drawRow(draft);
      }
    }
    this.clear.disabled = !snapshot.filters.conditions.length && !this.drafts.length;
    this.position();
  }
  save(change: (filters: FilterGroup) => void): Promise<boolean> {
    const operation = this.saveQueue.then(() => this.session()?.save(this.viewId, change) ?? false).catch(() => false);
    this.saveQueue = operation;
    return operation;
  }
  add(): void {
    const field = this.snapshot()?.fields[0]; if (!field) return;
    const draft: Draft = { rule: { id: makeId("filter"), fieldId: field.id, operator: filterOperators(field.type)[0] }, dirty: true, saving: new Set(), failed: false };
    this.drafts.push(draft); this.drawRow(draft); this.clear.disabled = false;
    draft.element?.querySelector<HTMLElement>(".tb-filter-field")?.focus({ preventScroll: true }); this.position();
    this.list.scrollTop = this.list.scrollHeight;
    if (this.panel.classList.contains("is-short-viewport")) this.panel.scrollTop = this.panel.scrollHeight;
  }
  drawRows(): void {
    this.list.replaceChildren(); this.drafts.forEach((draft) => this.drawRow(draft));
    this.clear.disabled = !this.drafts.length; this.position();
  }
  status(draft: Draft): void {
    const status = draft.element?.querySelector<HTMLElement>(".tb-filter-status");
    if (!status) return;
    status.textContent = draft.failed ? t("Could not save. Your changes have not been applied.") : "";
    status.hidden = !status.textContent;
    status.classList.toggle("is-error", draft.failed);
    draft.element?.classList.toggle("has-pending-changes", draft.dirty);
  }
  saveRule(draft: Draft): void {
    const field = this.snapshot()?.fields.find((item) => item.id === draft.rule.fieldId);
    draft.dirty = !draft.baseline || fingerprint(draft.rule) !== draft.baseline;
    this.status(draft);
    if (!field || !validFilterCondition(draft.rule, field)) return;
    const submitted = clone(draft.rule); const serialized = fingerprint(submitted);
    if (draft.saving.size ? draft.lastSubmitted === serialized : serialized === draft.baseline && !draft.failed) return;
    const token = makeId("filter-save"); draft.saving.add(token); draft.lastSubmitted = serialized; draft.failed = false;
    void this.save((filters) => {
      const index = filters.conditions.findIndex((rule) => rule.id === submitted.id);
      if (index >= 0) filters.conditions[index] = submitted; else filters.conditions.push(submitted);
    }).then((saved) => {
      draft.saving.delete(token);
      if (saved) { draft.failed = false; draft.baseline = serialized; draft.dirty = fingerprint(draft.rule) !== serialized; }
      else { draft.failed = true; draft.dirty = true; }
      this.status(draft);
    });
  }
  drawRow(draft: Draft): void {
    const fields = this.snapshot()?.fields ?? [];
    const field = fields.find((item) => item.id === draft.rule.fieldId);
    if (this.picker?.draft === draft) this.closePicker();
    if (this.selectMenu?.draft === draft) this.closeSelectMenu();
    const row = node("div", "tb-filter-condition"); row.dataset.conditionId = draft.rule.id;
    row.classList.toggle("is-range", draft.rule.operator === "between");
    const fieldWrap = node("div", "tb-filter-field-wrap tb-filter-select-wrap");
    const fieldSelect = this.selector("tb-filter-field", () => (this.snapshot()?.fields ?? []).map((item) => ({
      value: item.id, label: item.name || t("Untitled"), icon: fieldIcon[item.type],
    })), draft.rule.fieldId, (value) => this.chooseField(draft, value), draft,
    t("Missing field: {id}", { id: draft.rule.fieldId }));
    fieldWrap.append(icon(field ? fieldIcon[field.type] : "help-circle", "tb-filter-field-icon"), fieldSelect, icon("chevron-down", "tb-filter-select-chevron"));
    nameControl(fieldSelect, t("Filter field"));
    const operatorOptions = (field ? filterOperators(field.type) : [draft.rule.operator]).map((op) => ({
      value: op,
      label: field && (field.type === "date" || field.type === "datetime") && (op === "gt" || op === "lt") ? t(op === "gt" ? "After" : "Before") : t(operatorLabels[op]),
    }));
    const operator = this.selector("tb-filter-operator", () => operatorOptions, draft.rule.operator, (value) => {
      const previous = draft.rule.operator;
      draft.rule.operator = value as FilterOperator;
      if (draft.rule.operator !== "between") delete draft.rule.upper;
      if (field && field.type !== "multiselect" && ["eq", "neq"].includes(draft.rule.operator) && !["eq", "neq"].includes(previous) && Array.isArray(draft.rule.value) && draft.rule.value.length > 1) delete draft.rule.value;
      draft.dirty = true; this.drawRow(draft); this.saveRule(draft); this.position();
      draft.element?.querySelector<HTMLElement>(".tb-filter-operator")?.focus({ preventScroll: true });
    }, draft);
    const operatorWrap = node("div", "tb-filter-select-wrap tb-filter-operator-wrap");
    operatorWrap.append(operator, icon("chevron-down", "tb-filter-select-chevron"));
    row.append(fieldWrap, operatorWrap); nameControl(operator, t("Filter operator"));
    const values = node("div", "tb-filter-values");
    if (field && filterNeedsValue(draft.rule.operator)) {
      if (["select", "status", "multiselect"].includes(field.type)) {
        const choice = control("", undefined, "tb-input tb-filter-value-choice");
        values.append(choice); choice.removeAttribute("aria-label"); nameControl(choice, t("Filter values"));
        choice.setAttribute("aria-haspopup", "dialog"); choice.setAttribute("aria-expanded", "false");
        this.drawValueChoice(choice, draft, field);
        choice.onclick = () => this.openPicker(draft, field, choice);
      } else {
        const keys = draft.rule.operator === "between" ? ["value", "upper"] as const : ["value"] as const;
        const inputType = field.type === "number" ? "number" : field.type === "date" || field.type === "datetime" ? filterDateKind(field) : "text";
        const inputs = keys.length === 2 ? node("div", "tb-filter-range") : values;
        if (inputs !== values) { inputs.dataset.kind = inputType; values.append(inputs); }
        for (const key of keys) {
          if (key === "upper") {
            const separator = node("span", "tb-filter-range-separator", "–"); separator.setAttribute("aria-hidden", "true"); inputs.append(separator);
          }
          const input = node("input", "tb-input tb-filter-value"); input.dataset.bound = key;
          input.type = inputType;
          if (field.type === "number") input.step = "any";
          input.value = String(draft.rule[key] ?? "");
          input.classList.toggle("is-empty", !input.value);
          input.placeholder = t(key === "upper" ? "Maximum" : draft.rule.operator === "between" ? "Minimum" : "Value");
          inputs.append(input); nameControl(input, t(key === "upper" ? "Filter maximum" : draft.rule.operator === "between" ? "Filter minimum" : "Filter value"));
          const capture = () => {
            input.classList.toggle("is-empty", !input.value);
            draft.rule[key] = field.type === "number" ? input.value === "" ? undefined : Number(input.value) : input.value;
            draft.dirty = !draft.baseline || fingerprint(draft.rule) !== draft.baseline; this.status(draft);
          };
          input.oninput = capture;
          input.onchange = input.onblur = () => { capture(); this.saveRule(draft); };
          input.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); capture(); this.saveRule(draft); } };
        }
      }
    } else { values.classList.add("is-valueless"); row.classList.add("is-valueless"); }
    const remove = control("", "circle-minus", "tb-icon-button tb-filter-remove");
    row.append(values, remove); remove.removeAttribute("aria-label"); nameControl(remove, t("Delete condition"));
    remove.onclick = () => {
      if (this.picker?.draft === draft) this.closePicker();
      const removeDraft = () => { this.drafts = this.drafts.filter((item) => item !== draft); draft.element?.remove(); this.clear.disabled = !this.drafts.length; this.position(); };
      if (!draft.baseline && !draft.saving.size) removeDraft();
      else void this.save((filters) => { filters.conditions = filters.conditions.filter((rule) => rule.id !== draft.rule.id); }).then((saved) => { if (saved) removeDraft(); else { draft.failed = true; this.status(draft); } });
    };
    const status = node("div", "tb-filter-status"); status.setAttribute("role", "status"); row.append(status);
    if (draft.element?.isConnected) draft.element.replaceWith(row); else this.list.append(row);
    draft.element = row; this.status(draft);
  }
  chooseField(draft: Draft, fieldId: string): void {
    this.closeSelectMenu();
    if (fieldId === draft.rule.fieldId) return;
    const next = this.snapshot()?.fields.find((item) => item.id === fieldId); if (!next) return;
    const { value: _value, upper: _upper, ...retained } = draft.rule;
    draft.rule = { ...retained, fieldId: next.id, operator: filterOperators(next.type)[0] };
    draft.dirty = true; this.drawRow(draft); this.saveRule(draft); this.position();
    draft.element?.querySelector<HTMLElement>(".tb-filter-field")?.focus({ preventScroll: true });
  }
  closeSelectMenu(restoreFocus = false): void {
    const current = this.selectMenu; if (!current) return;
    this.selectMenu = null;
    current.trigger.setAttribute("aria-expanded", "false");
    current.menu.hide();
    if (restoreFocus && current.trigger.isConnected) current.trigger.focus({ preventScroll: true });
  }
  setSelectorValue(control: HTMLSelectElement | HTMLButtonElement, value: string, options: SelectOption[], fallback = value): void {
    control.value = value;
    const label = control.querySelector<HTMLElement>(".tb-filter-select-label");
    if (label) label.textContent = options.find((option) => option.value === value)?.label ?? fallback;
  }
  selector(className: string, options: () => SelectOption[], value: string, choose: (value: string) => void, draft?: Draft, fallback = value): HTMLSelectElement | HTMLButtonElement {
    if (Platform.isMobile) {
      const select = node("select", `tb-input ${className}`);
      const choices = options();
      if (!choices.some((option) => option.value === value)) choices.unshift({ value, label: fallback });
      for (const item of choices) { const option = node("option", "", item.label); option.value = item.value; select.append(option); }
      select.value = value; select.onchange = () => choose(select.value);
      return select;
    }
    const button = control("", undefined, `tb-input tb-filter-menu-trigger ${className}`);
    button.removeAttribute("aria-label");
    button.append(node("span", "tb-filter-select-label"));
    this.setSelectorValue(button, value, options(), fallback);
    button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-expanded", "false");
    const open = () => this.openSelectMenu(button, options(), (selected) => {
      this.closeSelectMenu(true);
      if (selected === button.value) return;
      this.setSelectorValue(button, selected, options()); choose(selected);
    }, draft);
    let suppressPointerClick = false;
    let pointerClickTimer: number | undefined;
    let pointerActivationSequence = 0;
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      suppressPointerClick = true;
      const sequence = ++pointerActivationSequence;
      if (pointerClickTimer !== undefined) button.ownerDocument.defaultView?.clearTimeout(pointerClickTimer);
      pointerClickTimer = button.ownerDocument.defaultView?.setTimeout(() => {
        if (sequence === pointerActivationSequence) { suppressPointerClick = false; pointerClickTimer = undefined; }
      }, 1000);
      button.ownerDocument.defaultView?.queueMicrotask(() => {
        if (sequence === pointerActivationSequence && button.isConnected && !this.closed) open();
      });
    });
    // Menu's window mousedown/click listeners would dismiss the menu opened by this pointerdown.
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.onclick = (event) => {
      event.stopPropagation();
      if (suppressPointerClick) {
        suppressPointerClick = false;
        if (pointerClickTimer !== undefined) button.ownerDocument.defaultView?.clearTimeout(pointerClickTimer);
        pointerClickTimer = undefined; return;
      }
      open();
    };
    button.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); }
    };
    return button;
  }
  openSelectMenu(trigger: HTMLButtonElement, options: SelectOption[], choose: (value: string) => void, draft?: Draft): void {
    this.hostDismissedMenu = null;
    if (this.selectMenu?.trigger === trigger) { this.closeSelectMenu(true); return; }
    this.closeSelectMenu(); this.closePicker();
    const menu = new Menu().setUseNativeMenu(false);
    for (const option of options) menu.addItem((item) => {
      item.setTitle(configMenuTitle(option.label)).setChecked(option.value === trigger.value).onClick(() => choose(option.value));
      if (option.icon) item.setIcon(option.icon);
    });
    this.selectMenu = { menu, draft, trigger }; trigger.setAttribute("aria-expanded", "true");
    showMenu(menu, trigger, undefined, () => {
      trigger.setAttribute("aria-expanded", "false");
      if (this.selectMenu?.menu !== menu) return;
      this.selectMenu = null;
      // Obsidian's window capture scope may hide Menu before our document Escape listener runs.
      const dismissed = this.hostDismissedMenu = { trigger };
      trigger.ownerDocument.defaultView?.setTimeout(() => {
        if (this.hostDismissedMenu === dismissed) this.hostDismissedMenu = null;
      }, 0);
    });
  }
  drawValueChoice(trigger: HTMLButtonElement, draft: Draft, field: Field): void {
    trigger.replaceChildren();
    const labels = node("span", "tb-filter-selected-values");
    const values = Array.isArray(draft.rule.value) ? draft.rule.value : [];
    for (const id of values) {
      const option = field.options?.find((item) => item.id === id);
      labels.append(node("span", `tb-pill tb-color-${option?.color ?? "gray"}`, option?.label ?? id));
    }
    if (!values.length) labels.append(node("span", "tb-filter-placeholder", t("Choose options…")));
    trigger.append(labels, icon("chevron-down", "tb-filter-value-chevron"));
  }
  closePicker(restoreFocus = false): void {
    const picker = this.picker; if (!picker) return;
    this.picker = null; picker.panel.remove(); picker.trigger.setAttribute("aria-expanded", "false"); picker.trigger.removeAttribute("aria-controls");
    if (restoreFocus) picker.trigger.focus({ preventScroll: true });
  }
  openPicker(draft: Draft, field: Field, trigger: HTMLButtonElement): void {
    this.hostDismissedMenu = null;
    this.closeSelectMenu();
    if (this.picker?.trigger === trigger) { this.closePicker(true); return; }
    this.closePicker();
    const panel = node("div", "tablebase-root tb-ui-surface tb-filter-values-menu"); panel.id = makeId("tb-filter-options");
    panel.setAttribute("role", "dialog");
    const search = node("input", "tb-input tb-filter-option-search"); search.type = "search"; search.placeholder = t("Search options…");
    panel.append(search); nameControl(search, t("Search options…"));
    const list = node("div", "tb-filter-option-list"); panel.append(list);
    const single = field.type !== "multiselect" && ["eq", "neq"].includes(draft.rule.operator);
    const draw = () => {
      const scroll = list.scrollTop; list.replaceChildren();
      const selected = new Set(Array.isArray(draft.rule.value) ? draft.rule.value : []);
      const options = field.options?.filter((option) => option.label.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) ?? [];
      for (const option of options) {
        const choice = control("", undefined, "tb-filter-option"); choice.removeAttribute("aria-label"); choice.type = "button";
        choice.dataset.optionId = option.id;
        choice.setAttribute("role", "checkbox"); choice.setAttribute("aria-checked", String(selected.has(option.id)));
        choice.append(icon("check", "tb-filter-option-check"), node("span", `tb-pill tb-color-${option.color}`, option.label));
        choice.onclick = () => {
          if (single) draft.rule.value = [option.id];
          else { if (selected.has(option.id)) selected.delete(option.id); else selected.add(option.id); draft.rule.value = [...selected]; }
          draft.dirty = true; this.drawValueChoice(trigger, draft, field); this.saveRule(draft);
          if (single) this.closePicker(true); else { draw(); this.position(); }
        };
        list.append(choice);
      }
      if (!options.length) list.append(node("div", "tb-filter-no-options", t("No matching options")));
      list.scrollTop = scroll;
    };
    this.picker = { panel, draft, trigger, search, draw };
    search.oninput = () => { draw(); this.position(); };
    this.panel.ownerDocument.body.append(panel); trigger.setAttribute("aria-expanded", "true"); trigger.setAttribute("aria-controls", panel.id);
    draw(); this.position(); search.focus({ preventScroll: true });
  }
}
