/**
 * Making elements, and putting them on the screen.
 *
 * There is no framework here and there is not going to be one. What this
 * interface draws is five lists and a form; the cost of a framework would be a
 * hundred and forty kilobytes in the browser and a second way of writing
 * everything, in a program whose whole character is that it carries no library
 * it can do without. `h` below is the entire abstraction.
 *
 * Drawing is a whole redraw. The view arrives complete — one document per
 * change, from the same gather the terminal interface redraws from — so working
 * out what changed would mean keeping a second copy of it to compare against.
 * A screenful of rows is a millisecond of DOM, and every screen is therefore a
 * function of the last view and nothing else, which is the same rule the
 * terminal interface is written to.
 *
 * The one thing a redraw would otherwise lose is where somebody was typing.
 * {@link renderInto} carries that across: an element that names itself with
 * `data-focus` gets its focus and its cursor back after the redraw, so a name
 * being typed into a field survives the view changing underneath it.
 */

/** What may be handed to {@link h} as a child. */
export type Child = Node | string | number | false | null | undefined;

/** Everything that can be said about an element in one call. */
export interface Attributes {
  readonly class?: string;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly title?: string;
  readonly href?: string;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  /**
   * Whether the thing this button opens is open, as `aria-expanded`.
   *
   * A button that opens a list has to say so, and has to say which state it is
   * in: without it a screen reader announces "简体中文, button" and nothing
   * about there being two other languages behind it.
   */
  readonly expanded?: boolean;
  /** That there is a list behind it at all, as `aria-haspopup`. */
  readonly haspopup?: boolean;
  /**
   * What this control is called, as `aria-label`.
   *
   * For the controls whose word is not on screen: a rail folded down to icons,
   * and the button that folds it. Everything else names itself with the text
   * inside it, and an `aria-label` there would be a second name that could
   * drift from the first.
   */
  readonly label?: string;
  readonly autocomplete?: string;
  readonly autofocus?: boolean;
  /** Named so a redraw can put the cursor back where it was. */
  readonly focusKey?: string;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onInput?: (value: string) => void;
  readonly onChange?: (value: string) => void;
  readonly onSubmit?: (event: SubmitEvent) => void;
  readonly onKeyDown?: (event: KeyboardEvent) => void;
}

function append(parent: Node, child: Child): void {
  if (child === false || child === null || child === undefined) {
    return;
  }
  parent.appendChild(
    typeof child === "string" || typeof child === "number"
      ? document.createTextNode(String(child))
      : child,
  );
}

/** One element, with everything about it. */
export function h(tag: string, attributes: Attributes = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  if (attributes.class !== undefined) {
    element.className = attributes.class;
  }
  if (attributes.type !== undefined) {
    element.setAttribute("type", attributes.type);
  }
  if (attributes.placeholder !== undefined) {
    element.setAttribute("placeholder", attributes.placeholder);
  }
  if (attributes.title !== undefined) {
    element.setAttribute("title", attributes.title);
  }
  if (attributes.href !== undefined) {
    element.setAttribute("href", attributes.href);
  }
  if (attributes.autocomplete !== undefined) {
    element.setAttribute("autocomplete", attributes.autocomplete);
  }
  if (attributes.autofocus === true) {
    element.setAttribute("data-autofocus", "");
  }
  if (attributes.focusKey !== undefined) {
    element.setAttribute("data-focus", attributes.focusKey);
  }
  if (attributes.disabled === true) {
    (element as HTMLButtonElement).disabled = true;
  }
  if (attributes.selected === true) {
    (element as HTMLOptionElement).selected = true;
  }
  if (attributes.expanded !== undefined) {
    element.setAttribute("aria-expanded", attributes.expanded ? "true" : "false");
  }
  if (attributes.haspopup === true) {
    element.setAttribute("aria-haspopup", "true");
  }
  if (attributes.label !== undefined) {
    element.setAttribute("aria-label", attributes.label);
  }
  // Set as a property rather than an attribute: an input's attribute is its
  // starting value, and a redraw that set it would leave a field showing one
  // thing and holding another.
  if (attributes.value !== undefined) {
    (element as HTMLInputElement).value = attributes.value;
  }

  if (attributes.onClick !== undefined) {
    element.addEventListener("click", attributes.onClick as EventListener);
  }
  if (attributes.onInput !== undefined) {
    const onInput = attributes.onInput;
    element.addEventListener("input", (event) => {
      onInput((event.target as HTMLInputElement).value);
    });
  }
  if (attributes.onChange !== undefined) {
    const onChange = attributes.onChange;
    element.addEventListener("change", (event) => {
      onChange((event.target as HTMLInputElement).value);
    });
  }
  if (attributes.onSubmit !== undefined) {
    const onSubmit = attributes.onSubmit;
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      onSubmit(event as SubmitEvent);
    });
  }
  if (attributes.onKeyDown !== undefined) {
    element.addEventListener("keydown", attributes.onKeyDown as EventListener);
  }

  for (const child of children) {
    append(element, child);
  }
  return element;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * An icon, drawn rather than fetched.
 *
 * SVG elements are not created by `document.createElement`, which is the whole
 * reason this is not just another call to {@link h}: an `<svg>` made in the
 * HTML namespace is an unknown element that renders as nothing, silently.
 *
 * Drawn here because the page's content security policy allows no image from
 * anywhere, and because an icon that arrives as markup takes its colour from
 * the text it sits beside — `currentColor` in the stylesheet — so it is right
 * in both themes without being drawn twice.
 *
 * `aria-hidden`, always: an icon here either sits beside the word it
 * illustrates, and one a screen reader also announced would say that word
 * twice, or it stands alone on a control that carries the word as its
 * {@link Attributes.label}, where the mark is the thing that is not the name.
 */
export function icon(className: string, ...paths: readonly string[]): SVGSVGElement {
  return iconIn(ICON_GRID, className, ...paths);
}

/** The grid the marks drawn for this interface are laid out on. */
const ICON_GRID = "0 0 16 16";

/**
 * The same, on a grid of its own.
 *
 * One mark here is not ours to redraw: the logo arrives with the coordinates it
 * was drawn at, and it keeps them. Rescaling a brand mark by hand onto somebody
 * else's grid is how a logo ends up nearly right.
 */
export function iconIn(
  viewBox: string,
  className: string,
  ...paths: readonly string[]
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  for (const definition of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", definition);
    svg.appendChild(path);
  }
  return svg;
}

/** Several children with no element around them. */
export function group(...children: Child[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const child of children) {
    append(fragment, child);
  }
  return fragment;
}

/** Whether an element is one a cursor can sit in. */
function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/**
 * Replace what is inside `container`, keeping the cursor where it was.
 *
 * The selection is carried across as well as the focus. Without it, a redraw
 * that arrived while somebody was halfway through a project name would put the
 * cursor at the end of what they had typed, which is the sort of thing that
 * makes an interface feel like it is fighting back.
 */
export function renderInto(container: HTMLElement, content: Node): void {
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement ? active.dataset.focus : undefined;
  const selection = isTextField(active)
    ? { start: active.selectionStart, end: active.selectionEnd }
    : undefined;

  container.replaceChildren(content);

  if (focusKey !== undefined) {
    const restored = container.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
    if (restored instanceof HTMLElement) {
      restored.focus();
      if (selection !== undefined && isTextField(restored)) {
        restored.setSelectionRange(selection.start, selection.end);
      }
      return;
    }
  }

  // Nothing was focused, or what was has gone. A field that asked for the
  // cursor gets it, which is how the sign-in form and a freshly opened editor
  // are ready to type into without anybody reaching for the mouse.
  const wants = container.querySelector("[data-autofocus]");
  if (wants instanceof HTMLElement) {
    wants.focus();
  }
}
