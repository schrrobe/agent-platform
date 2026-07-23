import { onMounted, onBeforeUnmount, type Ref } from 'vue';
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { JobState } from '@agent/shared';

export type { Edge };

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

/**
 * Registriert eine Karte als Reorder-Ziel: liefert die nächstgelegene Kante
 * (oben/unten) für das manuelle Umsortieren innerhalb einer Spalte.
 */
export function useCardDropTarget(
  elRef: Ref<HTMLElement | null>,
  options: {
    canDrop: (data: CardDragData) => boolean;
    onDrop: (data: CardDragData, edge: Edge | null) => void;
    onEdgeChange?: (edge: Edge | null) => void;
  },
): void {
  let cleanup: (() => void) | undefined;
  onMounted(() => {
    if (!elRef.value) return;
    const element = elRef.value;
    cleanup = dropTargetForElements({
      element,
      getIsSticky: () => true,
      canDrop: ({ source }) => options.canDrop(source.data as CardDragData),
      getData: ({ input }) =>
        attachClosestEdge({}, { element, input, allowedEdges: ['top', 'bottom'] }),
      onDrag: ({ self, source }) => {
        if (!options.canDrop(source.data as CardDragData)) {
          options.onEdgeChange?.(null);
          return;
        }
        options.onEdgeChange?.(extractClosestEdge(self.data));
      },
      onDragLeave: () => options.onEdgeChange?.(null),
      onDrop: ({ self, source }) => {
        options.onEdgeChange?.(null);
        const data = source.data as CardDragData;
        if (options.canDrop(data)) options.onDrop(data, extractClosestEdge(self.data));
      },
    });
  });
  onBeforeUnmount(() => cleanup?.());
}
