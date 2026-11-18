import { initializeI18n } from "../src/i18n/initializeI18n";

// FORK-ONLY: the app initializes GT at startup, and upstream does it only in its browser setup.
// The fork-only `dom` project renders components too, so it needs the same.
initializeI18n(() => {});
