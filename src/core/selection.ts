import type { CodeSelection } from './types';

function textFromNode(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>('.ra-line-code, [data-line-number], .line_content')?.textContent ?? '';
}

function pathFrom(element: Element | null, fallback: string) {
  const file = element?.closest('.diff-file, [data-file-path], .file-holder');
  const explicit = file?.querySelector<HTMLElement>('[data-file-path]')?.dataset.filePath;
  const title = file?.querySelector<HTMLElement>(
    '.file-title-name, .file-title-content a, .file-header-content',
  )?.textContent;
  return explicit ?? title?.trim().replace(/^.*?:\s*/, '') ?? fallback;
}

function lineFrom(element: Element | null) {
  const row = element?.closest<HTMLElement>('[data-line-number], .diff-td, .line_holder');
  const value = Number(row?.dataset.lineNumber ?? row?.dataset.line ?? row?.getAttribute('data-line-number'));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function captureCodeSelection(
  doc: Document,
  defaultPath = '',
): CodeSelection | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return null;

  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const startLine = lineFrom(start);
  const endLine = Math.max(startLine, lineFrom(end));
  const rect = range.getBoundingClientRect();

  return {
    filePath: pathFrom(start, defaultPath),
    side: 'new',
    startLine,
    endLine,
    text: text.slice(0, 3000),
    top: rect.top > 90 ? rect.top - 52 : rect.bottom + 10,
    left: Math.min(Math.max(rect.left + rect.width / 2, 190), window.innerWidth - 190),
  };
}

export function isSelectionInsideHost(target: EventTarget | null, host: HTMLElement) {
  return target instanceof Node && host.contains(target);
}
