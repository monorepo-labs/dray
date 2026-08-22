import { Markdown } from "@/components/chat/Markdown";

/// Full-width and unbubbled — assistant output is the page's main content, and
/// wrapping code blocks or tables in a bubble only costs horizontal room.
export default function AssistantMessage({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return <Markdown streaming={streaming}>{text}</Markdown>;
}
