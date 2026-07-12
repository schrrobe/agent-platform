import { onMounted, onBeforeUnmount, type Ref } from 'vue';
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { JobState } from '@agent/shared';

export interface CardDragData {
  jobId: string;
  from: JobState;
  [key: string]: unknown;
}

/** Macht ein Element ziehbar und hängt die Kartendaten an. */
export function useDraggableCard(
  elRef: Ref<HTMLElement | null>,
  getData: () => CardDragData,
  onDraggingChange?: (dragging: boolean) => void,
): void {
  let cleanup: (() => void) | undefined;
  onMounted(() => {
    if (!elRef.value) return;
    cleanup = draggable({
      element: elRef.value,
      getInitialData: () => ({ ...getData() }),
      onDragStart: () => onDraggingChange?.(true),
      onDrop: () => onDraggingChange?.(false),
    });
  });
  onBeforeUnmount(() => cleanup?.());
}

/** Registriert ein Element als Ablageziel für Karten. */
export function useDropTarget(
  elRef: Ref<HTMLElement | null>,
  options: {
    canDrop: (data: CardDragData) => boolean;
    onDrop: (data: CardDragData) => void;
    onOverChange?: (over: boolean, allowed: boolean) => void;
  },
): void {
  let cleanup: (() => void) | undefined;
  onMounted(() => {
    if (!elRef.value) return;
    cleanup = dropTargetForElements({
      element: elRef.value,
      canDrop: ({ source }) => options.canDrop(source.data as CardDragData),
      onDragEnter: ({ source }) =>
        options.onOverChange?.(true, options.canDrop(source.data as CardDragData)),
      onDragLeave: () => options.onOverChange?.(false, false),
      onDrop: ({ source }) => {
        options.onOverChange?.(false, false);
        const data = source.data as CardDragData;
        if (options.canDrop(data)) options.onDrop(data);
      },
    });
  });
  onBeforeUnmount(() => cleanup?.());
}
