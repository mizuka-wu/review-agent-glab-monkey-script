import type { GitLabRoute, PageContext } from './types';

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const normalizePath = (value: string) =>
  value
    .split('/')
    .filter(Boolean)
    .map(decodeSegment)
    .join('/');

export function parseGitLabUrl(input: string | URL, documentRef?: Document): PageContext {
  const url = input instanceof URL ? input : new URL(input);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
  const legacyIndex = segments.lastIndexOf('merge_requests');
  const modernIndex = segments.indexOf('-');

  const projectSegments =
    modernIndex > 0
      ? segments.slice(0, modernIndex)
      : legacyIndex > 0
        ? segments.slice(0, legacyIndex)
        : [];

  if (projectSegments.length === 0) {
    return {
      origin: url.origin,
      route: 'unknown',
      projectPath: '',
    };
  }

  const rest =
    modernIndex >= 0
      ? segments.slice(modernIndex + 1)
      : legacyIndex >= 0
        ? segments.slice(legacyIndex)
        : [];

  let route: GitLabRoute = 'unknown';
  let mergeRequestIid: number | undefined;
  let filePath: string | undefined;
  let commitSha: string | undefined;

  if (rest[0] === 'merge_requests') {
    const iid = Number(rest[1]);
    if (Number.isInteger(iid) && iid > 0) {
      mergeRequestIid = iid;
      route = rest[2] === 'diffs' || rest[2] === 'commits' ? 'diff' : 'merge-request';
    }
  } else if (rest[0] === 'blob' || rest[0] === 'raw' || rest[0] === 'tree') {
    route = 'file';
    filePath = normalizePath(rest.slice(2).join('/'));
  } else if (rest[0] === 'commit') {
    route = 'commit';
    commitSha = rest[1];
  } else if (rest[0] === 'commits') {
    route = 'commit';
  }

  const dataPage = documentRef?.body?.dataset.page ?? '';
  if (!mergeRequestIid && dataPage.includes('merge_requests')) {
    const iidFromUrl = url.pathname.match(/merge_requests\/(\d+)/)?.[1];
    if (iidFromUrl) {
      mergeRequestIid = Number(iidFromUrl);
      route = 'merge-request';
    }
  }

  return {
    origin: url.origin,
    route,
    projectPath: projectSegments.join('/'),
    mergeRequestIid,
    filePath,
    commitSha,
  };
}

export function projectApiIdentifier(page: Pick<PageContext, 'projectPath' | 'projectNumericId'>) {
  return String(page.projectNumericId ?? encodeURIComponent(page.projectPath));
}

export function isGitLabDocument(documentRef: Document, locationRef: Location = window.location) {
  const parsed = parseGitLabUrl(locationRef.href, documentRef);
  const hasGitLabChrome = Boolean(
    documentRef.querySelector(
      '[data-page^="projects:"], .navbar-gitlab, .gl-header, meta[name="gon"]',
    ),
  );
  return parsed.projectPath.length > 0 && (parsed.route !== 'unknown' || hasGitLabChrome);
}
