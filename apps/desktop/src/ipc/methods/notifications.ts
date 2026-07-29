import { DesktopNotificationInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Retain shown notifications so they are not garbage-collected before the user
// interacts with them — on macOS/Linux a collected Notification can drop its
// pending "click" handler. Released on click or close.
const activeNotifications = new Set<Electron.Notification>();

/**
 * Raise a native OS notification from the renderer. Built inline (mirroring
 * openExternal) rather than behind a dedicated Electron service — it is a
 * one-shot side effect plus a click handler.
 *
 * On click we reveal the app window and push the structured thread reference to
 * the renderer over NOTIFICATION_ACTIVATED_CHANNEL, reusing the same
 * main -> renderer pattern as onMenuAction. The renderer routes to the thread.
 */
export const showNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_NOTIFICATION_CHANNEL,
  payload: DesktopNotificationInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.showNotification")(function* (input) {
    if (!Electron.Notification.isSupported()) {
      return;
    }

    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
    const runPromise = Effect.runPromiseWith(context);

    const notification = new Electron.Notification({
      title: input.title,
      body: input.body,
    });
    activeNotifications.add(notification);
    notification.on("close", () => {
      activeNotifications.delete(notification);
    });

    notification.on("click", () => {
      activeNotifications.delete(notification);
      void runPromise(
        Effect.gen(function* () {
          const target = yield* electronWindow.currentMainOrFirst;
          if (Option.isNone(target)) {
            return;
          }
          const window = target.value;
          yield* electronWindow.reveal(window);
          if (!window.isDestroyed()) {
            window.webContents.send(IpcChannels.NOTIFICATION_ACTIVATED_CHANNEL, input.threadRef);
          }
        }),
      );
    });

    notification.show();
  }),
});
