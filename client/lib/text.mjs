// Prompt text is written in the source wrapped at 120 characters. unwrap() joins such lines again, so the model (and
// anyone reading the prompt) sees whole sentences: a line is joined to the one before it unless it is empty, or starts
// a list item ("- ", "* ", "1. "), a heading ("#") or a tag ("<").
export function unwrap(text) {
	const out = [];
	for (const raw of String(text).split("\n")) {
		const line = raw.trimEnd();
		const t = line.trimStart();
		const prev = out[out.length - 1];
		if (prev !== undefined && prev.trim() && t && !/^([-*] |\d+[.)] |#|<|\|)/.test(t) && !/[:]$/.test(prev.trim())) {
			out[out.length - 1] = `${prev} ${t}`;
		} else {
			out.push(line);
		}
	}
	return out.join("\n");
}
