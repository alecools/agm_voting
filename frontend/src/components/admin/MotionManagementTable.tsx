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

export interface MotionManagementTableProps {
  motions: MotionDetail[];
  meetingStatus: string;
  onReorder: (newOrder: MotionDetail[]) => void;
  isReorderPending: boolean;
  reorderError: string | null;
  pendingVisibilityMotionId: string | null;
  isBulkLoading: boolean;
  motionsWithVotes: Set<string>;
  visibilityErrors: Record<string, string>;
  onToggleVisibility: (motionId: string, isVisible: boolean) => void;
  onEdit: (motion: MotionDetail) => void;
  onDelete: (motionId: string) => void;
  deleteMotionErrors: Record<string, string>;
}

interface SortableRowProps {
  motion: MotionDetail;
  index: number;
  total: number;
  isEditable: boolean;
  isReorderPending: boolean;
  meetingStatus: string;
  pendingVisibilityMotionId: string | null;
  isBulkLoading: boolean;
  motionsWithVotes: Set<string>;
  visibilityErrors: Record<string, string>;
  onToggleVisibility: (motionId: string, isVisible: boolean) => void;
  onEdit: (motion: MotionDetail) => void;
  onDelete: (motionId: string) => void;
  deleteMotionErrors: Record<string, string>;
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
  isReorderPending,
  meetingStatus,
  pendingVisibilityMotionId,
  isBulkLoading,
  motionsWithVotes,
  visibilityErrors,
  onToggleVisibility,
  onEdit,
  onDelete,
  deleteMotionErrors,
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
  } = useSortable({ id: motion.id, disabled: !isEditable || isReorderPending });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    /* c8 ignore next -- isDragging=true only during active pointer drag, not exercisable in JSDOM */
    opacity: isDragging ? 0.5 : 1,
  };

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const label = motion.motion_number?.trim() || String(motion.display_order);
  const isClosed = meetingStatus === "closed";

  const isVisLoading = pendingVisibilityMotionId === motion.id;
  const isVisDisabled =
    isClosed ||
    motionsWithVotes.has(motion.id) ||
    isVisLoading ||
    isBulkLoading;
  const disabledReason =
    isClosed
      ? "Meeting is closed"
      : motionsWithVotes.has(motion.id)
      ? "Motion has received votes"
      : undefined;

  const isEditDeleteDisabled = motion.is_visible || isClosed;
  const editDeleteTitle = isEditDeleteDisabled ? "Hide this motion first to edit or delete" : undefined;
  const mutedCell = !motion.is_visible ? "admin-table__cell--muted" : undefined;

  return (
    <tr ref={setNodeRef} style={style} data-testid={`motion-row-${motion.id}`}>
      {isEditable && (
        <td className="admin-table__drag-handle">
          {total > 1 && (
            <>
              <span
                {...attributes}
                {...listeners}
                aria-label={`Drag to reorder ${motion.title}`}
                data-testid={`drag-handle-${motion.id}`}
                style={{ cursor: isReorderPending ? "not-allowed" : "grab", fontSize: "1.2rem", userSelect: "none" }}
              >
                &#x2807;
              </span>
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ padding: "2px 6px", fontSize: "0.75rem" }}
                  aria-label={`Move ${motion.title} to top`}
                  onClick={onMoveTop}
                  disabled={isFirst || isReorderPending}
                >
                  &#x2912;
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ padding: "2px 6px", fontSize: "0.75rem" }}
                  aria-label={`Move ${motion.title} up`}
                  onClick={onMoveUp}
                  disabled={isFirst || isReorderPending}
                >
                  &#x2191;
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ padding: "2px 6px", fontSize: "0.75rem" }}
                  aria-label={`Move ${motion.title} down`}
                  onClick={onMoveDown}
                  disabled={isLast || isReorderPending}
                >
                  &#x2193;
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ padding: "2px 6px", fontSize: "0.75rem" }}
                  aria-label={`Move ${motion.title} to bottom`}
                  onClick={onMoveBottom}
                  disabled={isLast || isReorderPending}
                >
                  &#x2913;
                </button>
              </div>
            </>
          )}
        </td>
      )}
      <td
        className={mutedCell}
        style={{ fontFamily: "'Overpass Mono', monospace", color: "var(--text-muted)" }}
      >
        {label}
      </td>
      <td className={mutedCell}>
        <span style={{ fontWeight: 500 }}>{motion.title}</span>
        {motion.description && (
          <p style={{ margin: "2px 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {motion.description}
          </p>
        )}
      </td>
      <td className={mutedCell}>
        <span
          className={`motion-type-badge motion-type-badge--${motion.motion_type}`}
          aria-label={`Motion type: ${motion.motion_type === "special" ? "Special" : "General"}`}
        >
          {motion.motion_type === "special" ? "Special" : "General"}
        </span>
      </td>
      <td>
        <label
          className={`motion-visibility-toggle${isVisDisabled ? " motion-visibility-toggle--disabled" : ""}${isVisLoading ? " motion-visibility-toggle--loading" : ""}`}
          title={disabledReason}
        >
          <input
            type="checkbox"
            className="motion-visibility-toggle__input"
            checked={motion.is_visible}
            disabled={isVisDisabled}
            onChange={() => onToggleVisibility(motion.id, !motion.is_visible)}
          />
          <span className="motion-visibility-toggle__track" />
          <span className="motion-visibility-toggle__label">
            {motion.is_visible ? "Visible" : "Hidden"}
          </span>
        </label>
        {visibilityErrors[motion.id] && (
          <span style={{ display: "block", color: "var(--red)", fontSize: "0.875rem", marginTop: 4 }} role="alert">
            {visibilityErrors[motion.id]}
          </span>
        )}
      </td>
      {!isClosed && (
        <td>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn--secondary"
              style={{ padding: "5px 14px", fontSize: "0.8rem" }}
              disabled={isEditDeleteDisabled}
              title={editDeleteTitle}
              onClick={() => onEdit(motion)}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={isEditDeleteDisabled}
              title={editDeleteTitle}
              onClick={() => onDelete(motion.id)}
            >
              Delete
            </button>
          </div>
          {deleteMotionErrors[motion.id] && (
            <span style={{ display: "block", color: "var(--red)", fontSize: "0.875rem", marginTop: 4 }} role="alert">
              {deleteMotionErrors[motion.id]}
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

export default function MotionManagementTable({
  motions,
  meetingStatus,
  onReorder,
  isReorderPending,
  reorderError,
  pendingVisibilityMotionId,
  isBulkLoading,
  motionsWithVotes,
  visibilityErrors,
  onToggleVisibility,
  onEdit,
  onDelete,
  deleteMotionErrors,
}: MotionManagementTableProps) {
  const isEditable = meetingStatus === "open" || meetingStatus === "pending";
  const isClosed = meetingStatus === "closed";

  const [localOrder, setLocalOrder] = useState<MotionDetail[]>(motions);

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
    /* c8 ignore next -- dnd-kit fires onDragEnd with over=null only on cancelled drags */
    if (!over || active.id === over.id) return;

    const oldIndex = localOrder.findIndex((m) => m.id === active.id);
    const newIndex = localOrder.findIndex((m) => m.id === over.id);
    /* c8 ignore next -- unreachable: DndContext only fires with IDs in SortableContext */
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
      {reorderError && (
        <p role="alert" style={{ color: "var(--red)", marginBottom: 8, fontSize: "0.875rem" }}>
          {reorderError}
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
          <div className="admin-table-wrapper">
            <table className="admin-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  {isEditable && <th style={{ width: 40 }}></th>}
                  <th>#</th>
                  <th>Motion</th>
                  <th>Type</th>
                  <th>Visibility</th>
                  {!isClosed && <th>Actions</th>}
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
                    isReorderPending={isReorderPending}
                    meetingStatus={meetingStatus}
                    pendingVisibilityMotionId={pendingVisibilityMotionId}
                    isBulkLoading={isBulkLoading}
                    motionsWithVotes={motionsWithVotes}
                    visibilityErrors={visibilityErrors}
                    onToggleVisibility={onToggleVisibility}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    deleteMotionErrors={deleteMotionErrors}
                    onMoveTop={() => moveItem(index, 0)}
                    onMoveUp={() => moveItem(index, index - 1)}
                    onMoveDown={() => moveItem(index, index + 1)}
                    onMoveBottom={() => moveItem(index, localOrder.length - 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
