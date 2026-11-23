export const diagramFormat = `Return an object with an elements array, in paint order, for a 640 by 400 diagram.
Each element is an array in one of these forms:
  ["line", x1, y1, x2, y2, "#RRGGBB"]
  ["rect", x, y, width, height, "#RRGGBB"]
  ["circle", centerX, centerY, radius, "#RRGGBB"]
  ["polyline", [[x1,y1],[x2,y2],...], "#RRGGBB"]
  ["text", x, y, "Readably short label", "#RRGGBB"]
Coordinates originate at the upper left. Use up to 100 elements and up to 160 points per polyline.
The background is white. Add labels and geometry for the primary case.`;

const escape = s => s.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
const color = s => typeof s === 'string' && /^#[a-f0-9]{6}$/i.test(s);
const coordinate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 640;
const label = text => typeof text === 'string' && text.length > 0 && text.length <= 150 && !/[\x00-\x1F\x7F]/.test(text);

export function renderDiagram(diagram, title) {
  const { elements } = diagram ?? {};
  if (!Array.isArray(elements) || elements.length < 1 || elements.length > 100) throw new Error('Invalid diagram element count.');
  const geometry = elements.map(element => {
    if (!Array.isArray(element)) throw new Error('Invalid diagram element.');
    const [kind, ...args] = element;
    const ink = args.pop();
    if (!color(ink)) throw new Error('Invalid diagram color.');
    const [a, b, c, d] = args;
    if (kind === 'line' && args.length === 4 && args.every(coordinate)) {
      return `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${ink}" stroke-width="3"/>`;
    }
    if (kind === 'rect' && args.length === 4 && args.every(coordinate)) {
      return `<rect x="${a}" y="${b}" width="${c}" height="${d}" fill="${ink}"/>`;
    }
    if (kind === 'circle' && args.length === 3 && args.every(coordinate)) {
      return `<circle cx="${a}" cy="${b}" r="${c}" fill="${ink}"/>`;
    }
    if (kind === 'text' && args.length === 3 && coordinate(a) && coordinate(b) && label(c)) {
      return `<text x="${a}" y="${b}" fill="${ink}" font-size="17" font-family="sans-serif">${escape(c)}</text>`;
    }
    if (kind === 'polyline' && args.length === 1 && Array.isArray(a) && a.length >= 2 && a.length <= 160 &&
      a.every(p => Array.isArray(p) && p.length === 2 && p.every(coordinate))) {
      return `<polyline points="${a.map(p => p.join(',')).join(' ')}" fill="none" stroke="${ink}" stroke-width="3"/>`;
    }
    throw new Error('Invalid diagram geometry.');
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" role="img">
<title>${escape(title)}</title>
<rect width="640" height="400" fill="#ffffff"/>
${geometry.join('\n')}
</svg>\n`;
}
