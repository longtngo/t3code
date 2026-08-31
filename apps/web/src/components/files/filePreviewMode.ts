import {
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

/**
 * Files the preview panel renders from their asset URL instead of a text read.
 * The read is not merely wasteful for them: it comes back "is binary and cannot
 * be previewed as text", which is the error a workspace video used to show.
 */
export const rendersFromAssetUrl = (path: string): boolean =>
  isWorkspaceImagePreviewPath(path) || isWorkspaceVideoPreviewPath(path);

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
