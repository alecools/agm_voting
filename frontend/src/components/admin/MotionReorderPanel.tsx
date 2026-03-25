import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MotionDetail } from "../../api/admin";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MotionReorderPanelProps {
  motions: MotionDetail[];
  meetingStatus: string;
  onReorder: (newOrder: MotionDetail[]) => void;
  isPending?: boolean;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// SortableRow — individual drag row
// ---------------------------------------------------------------------------

interface SortableRowProps {
  motion: MotionDetail;
  index: number;
  total: number;
  isEditable: boolean;
  isPending: boolean;
  onMoveTop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveBottom: () => void;
}

function SortableRow({
  motion,
  index,
  total,
  isEditable,
  isPending,
  onMoveTop,
  onMoveUp,
  onMoveDown,
  onMoveBottom,
}: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: motion.id, disabled: !isEditable || isPending });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    /* istanbul ignore next -- isDragging=true only during active pointer drag, not exercisable in JSDOM */
    opacity: isDragging ? 0.5 : 1,
  };

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const label = motion.motion_number?.trim() || String(motion.display_order);

  return (
    <tr ref={setNodeRef} style={style} data-testid={`motion-row-${motion.id}`}>
      {isEditable && (
        <td className="admin-table__drag-handle">
          {total > 1 && (
            <span
              {...attributes}
              {...listeners}
              aria-label={`Drag to reorder ${motion.title}`}
              data-testid={`drag-handle-${motion.id}`}
              style={{ cursor: isPending ? "not-allowed" : "grab", fontSize: "1.2rem", userSelect: "none" }}
            >
              ⠿
            </span>
          )}
        </td>
      )}
      <td style={{ fontVariantNumeric: "tabular-nums", width: 48 }}>{label}</td>
      <td>{motion.title}</td>
      <td style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>{motion.motion_type}</td>
      {isEditable && (
        <td>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: "2px 6px", fontSize: "0.75rem" }}
              aria-label={`Move ${motion.title} to top`}
              onClick={onMoveTop}
              disabled={isFirst || isPending}
            >
              ⤒
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: "2px 6px", fontSize: "0.75rem" }}
              aria-label={`Move ${motion.title} up`}
              onClick={onMoveUp}
              disabled={isFirst || isPending}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: "2px 6px", fontSize: "0.75rem" }}
              aria-label={`Move ${motion.title} down`}
              onClick={onMoveDown}
              disabled={isLast || isPending}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: "2px 6px", fontSize: "0.75rem" }}
              aria-label={`Move ${motion.title} to bottom`}
              onClick={onMoveBottom}
              disabled={isLast || isPending}
            >
              ⤓
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// MotionReorderPanel
// ---------------------------------------------------------------------------

export default function MotionReorderPanel({
  motions,
  meetingStatus,
  onReorder,
  isPending = false,
  error = null,
}: MotionReorderPanelProps) {
  const isEditable = meetingStatus === "open" || meetingStatus === "pending";

  // Local copy for optimistic drag-and-drop display — actual order is
  // managed by the parent via onReorder
  const [localOrder, setLocalOrder] = useState<MotionDetail[]>(motions);

  // Keep localOrder in sync when props change (e.g. after API response)
  if (
    motions.length !== localOrder.length ||
    motions.some((m, i) => m.id !== localOrder[i]?.id || m.display_order !== localOrder[i]?.display_order)
  ) {
    setLocalOrder(motions);
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    /* istanbul ignore next -- dnd-kit fires onDragEnd with over=null only on cancelled drags (Escape key / pointer cancel); not exercisable in JSDOM */
    if (!over || active.id === over.id) return;

    const oldIndex = localOrder.findIndex((m) => m.id === active.id);
    const newIndex = localOrder.findIndex((m) => m.id === over.id);
    /* istanbul ignore next -- unreachable: DndContext only fires with IDs that exist in the SortableContext items array */
    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = arrayMove(localOrder, oldIndex, newIndex);
    setLocalOrder(newOrder);
    onReorder(newOrder);
  }

  function applyMove(newOrder: MotionDetail[]) {
    setLocalOrder(newOrder);
    onReorder(newOrder);
  }

  function moveItem(fromIndex: number, toIndex: number) {
    applyMove(arrayMove(localOrder, fromIndex, toIndex));
  }

  return (
    <div>
      {error && (
        <p role="alert" style={{ color: "var(--red)", marginBottom: 8, fontSize: "0.875rem" }}>
          {error}
        </p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={localOrder.map((m) => m.id)}
          strategy={verticalListSortingStrategy}
        >
          <table className="admin-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                {isEditable && <th style={{ width: 40 }}></th>}
                <th>#</th>
                <th>Title</th>
                <th>Type</th>
                {isEditable && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {localOrder.map((motion, index) => (
                <SortableRow
                  key={motion.id}
                  motion={motion}
                  index={index}
                  total={localOrder.length}
                  isEditable={isEditable}
                  isPending={isPending}
                  onMoveTop={() => moveItem(index, 0)}
                  onMoveUp={() => moveItem(index, index - 1)}
                  onMoveDown={() => moveItem(index, index + 1)}
                  onMoveBottom={() => moveItem(index, localOrder.length - 1)}
                />
              ))}
            </tbody>
          </table>
        </SortableContext>
      </DndContext>
    </div>
  );
}
