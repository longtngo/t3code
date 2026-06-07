export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

/**
 * Width override that expands a right panel to (almost) the full window width.
 * Layered after {@link RIGHT_PANEL_SHEET_CLASS_NAME} so tailwind-merge wins the
 * width/min/max conflicts; the small gap keeps the backdrop clickable to close.
 */
export const RIGHT_PANEL_SHEET_EXPANDED_CLASS_NAME =
  "w-[calc(100%-(--spacing(12)))] min-w-0 max-w-none max-[760px]:w-[calc(100%-(--spacing(12)))]";
