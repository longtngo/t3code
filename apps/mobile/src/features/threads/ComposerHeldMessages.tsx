/**
 * The held-message strip: what the thread is holding until the running turn
 * finishes.
 *
 * Web puts this in its Tasks drawer tier. Mobile has no such tier, so it sits
 * directly above the composer surface, in the same band the connection pill
 * uses — the only place above the input that is not already spoken for by an
 * approval or user-input card.
 *
 * Collapsed by default. A held message is information, not a prompt, and
 * expanding the list over a phone keyboard costs more than it is usually worth.
 */
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

export interface ComposerHeldMessage {
  readonly id: string;
  readonly text: string;
  readonly attachmentCount: number;
}

export const ComposerHeldMessages = memo(function ComposerHeldMessages(props: {
  readonly messages: ReadonlyArray<ComposerHeldMessage>;
  readonly onRecall: ((messageId: string) => void) | null;
  readonly recallPendingId: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  if (props.messages.length === 0) {
    return null;
  }
  const count = props.messages.length;
  return (
    <Animated.View
      className="mb-2 overflow-hidden rounded-2xl bg-card"
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${String(count)} message${count === 1 ? "" : "s"} waiting to send`}
        accessibilityState={{ expanded: isExpanded }}
        onPress={() => {
          setIsExpanded((open) => !open);
        }}
        className="flex-row items-center gap-2 px-3 py-2 active:opacity-70"
      >
        <Text className="font-t3-bold text-sm tabular-nums text-foreground">{count}</Text>
        <Text className="flex-1 font-t3-medium text-sm text-foreground-muted">waiting to send</Text>
        <Text className="font-t3-medium text-xs text-foreground-muted">
          {isExpanded ? "Hide" : "Show"}
        </Text>
      </Pressable>
      {isExpanded ? (
        <View className="gap-1 px-3 pb-3">
          {props.messages.map((message) => (
            <View
              key={message.id}
              className="flex-row items-start gap-2 rounded-xl bg-subtle-strong px-2.5 py-2"
            >
              <Text className="min-w-0 flex-1 font-t3-medium text-xs text-foreground">
                {message.text}
                {message.attachmentCount > 0 ? (
                  <Text className="text-foreground-muted">
                    {` (${String(message.attachmentCount)} attachment${
                      message.attachmentCount === 1 ? "" : "s"
                    })`}
                  </Text>
                ) : null}
              </Text>
              {props.onRecall === null ? null : props.recallPendingId === message.id ? (
                <ActivityIndicator size="small" />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Bring this message back to the composer"
                  disabled={props.recallPendingId !== null}
                  onPress={() => {
                    props.onRecall?.(message.id);
                  }}
                  className="shrink-0 rounded-lg px-2 py-1 active:opacity-70"
                >
                  <Text className="font-t3-bold text-xs text-foreground">Edit</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      ) : null}
    </Animated.View>
  );
});
