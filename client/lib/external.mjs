// Marks text that came from outside (web pages, search results, files) so the model can tell it from the user's words.
// The source is shown in the marker; a closing tag inside the content cannot end the marker early.
const esc = (s) => String(s).replace(/<(\/?)external/gi, "<​$1external");
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/[\r\n]+/g, " ");

export function wrapExternal(source, text) {
	return `<external source="${attr(source)}">\n${esc(text)}\n</external>`;
}
