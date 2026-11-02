/**
 * The lazy part that defines a brand: the Brand panel, Save as template and the template editor. lazy.ts fetches the
 * brand checks and Depthcue's own styles and templates with it, so the panel refuses a color that leaves text
 * unreadable from its first keystroke and lists the built-ins it can copy.
 */
export { closeBrand, openBrand } from "./brandpanel.ts";
export { editTemplate } from "./templateedit.ts";
export { saveTemplate } from "./templatesave.ts";
