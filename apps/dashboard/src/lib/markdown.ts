import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

/**
 * Rendert Markdown zu sanitisiertem HTML. Ticketbeschreibungen und Agenten-
 * Artefakte sind unvertrauenswürdig — die Ausgabe wird immer über DOMPurify
 * geführt, um XSS über eingebettetes HTML zu verhindern.
 */
export function renderMarkdown(input: string): string {
  const raw = marked.parse(input ?? '', { async: false }) as string;
  return DOMPurify.sanitize(raw);
}
