import type { Finding } from './types';

/**
 * Highlight finding locations on the GitLab diff page.
 * Adds visual indicators to the diff lines matching the finding.
 */
export function highlightFindingOnPage(finding: Finding): HTMLElement[] {
  // Remove existing highlights
  clearHighlights();

  const highlighted: HTMLElement[] = [];
  const rows = document.querySelectorAll<HTMLElement>('[data-line-number], .line_holder');

  for (const row of rows) {
    const lineNumber = Number(row.dataset.lineNumber ?? row.dataset.line ?? '0');
    const pathContainer = row.closest('[data-file-path], .diff-file');
    const filePath = pathContainer?.getAttribute('data-file-path')
      ?? pathContainer?.querySelector('.file-title-name')?.textContent?.trim()
      ?? '';

    // Check if this row matches the finding
    const matchesLine = lineNumber >= finding.line && lineNumber <= finding.endLine;
    const matchesPath = filePath.includes(finding.path) || finding.path.includes(filePath);

    if (matchesLine && (matchesPath || !filePath)) {
      row.setAttribute('data-ra-highlight', 'true');
      row.classList.add('ra-finding-highlight');

      // Add severity indicator
      const indicator = document.createElement('div');
      indicator.className = `ra-finding-marker severity-${finding.severity}`;
      indicator.title = `${finding.severity}: ${finding.title}`;
      indicator.textContent = finding.severity === 'critical' || finding.severity === 'high' ? '!' : '•';
      row.style.position = 'relative';
      row.prepend(indicator);
      highlighted.push(row);
    }
  }

  // Also try to highlight by existingCode match
  if (highlighted.length === 0 && finding.existingCode) {
    const codeElements = document.querySelectorAll<HTMLElement>('code, .line_content, .blob-code');
    for (const el of codeElements) {
      const text = el.textContent ?? '';
      if (text.includes(finding.existingCode.trim().slice(0, 50))) {
        const row = el.closest<HTMLElement>('[data-line-number], .line_holder') ?? el;
        row.setAttribute('data-ra-highlight', 'true');
        row.classList.add('ra-finding-highlight');
        highlighted.push(row);
      }
    }
  }

  // Scroll to first highlight
  if (highlighted.length > 0) {
    highlighted[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return highlighted;
}

/**
 * Clear all finding highlights from the page.
 */
export function clearHighlights(): void {
  document.querySelectorAll('[data-ra-highlight]').forEach((el) => {
    el.removeAttribute('data-ra-highlight');
    el.classList.remove('ra-finding-highlight');
  });
  document.querySelectorAll('.ra-finding-marker').forEach((el) => el.remove());
}

/**
 * Add persistent visual style for finding highlights.
 * Injected once into the page.
 */
export function injectHighlightStyles(): void {
  if (document.getElementById('ra-finding-highlight-styles')) return;

  const style = document.createElement('style');
  style.id = 'ra-finding-highlight-styles';
  style.textContent = `
    .ra-finding-highlight {
      box-shadow: inset 4px 0 0 #2f6fed !important;
      background: rgba(47, 111, 237, 0.08) !important;
    }
    .ra-finding-marker {
      position: absolute;
      left: -24px;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      z-index: 10;
      pointer-events: none;
    }
    .ra-finding-marker.severity-critical,
    .ra-finding-marker.severity-high { background: #d3453b; }
    .ra-finding-marker.severity-medium { background: #d39a27; }
    .ra-finding-marker.severity-low { background: #3c78c7; }
  `;
  document.head.appendChild(style);
}
