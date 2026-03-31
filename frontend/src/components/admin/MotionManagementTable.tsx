import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
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
    touchAction: isDragging ? ("none" as const) : undefined,
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
            <span
              {...attributes}
              {...listeners}
              aria-label={`Drag to reorder ${motion.title}`}
              data-testid={`drag-handle-${motion.id}`}
              style={{
              cursor: isReorderPending ? "not-allowed" : "grab",
              fontSize: "1.2rem",
              userSelect: "none",
              touchAction: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 44,
              minHeight: 44,
            }}
            >
              &#x2807;
            </span>
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
        {motion.is_multi_choice && (
          <span
            className="motion-type-badge motion-type-badge--multi-choice-indicator"
            aria-label={`Voting mechanism: Multi-choice${motion.options && motion.options.length > 0 ? ` (${motion.options.length} options)` : ""}`}
          >
            {`Multi-choice${motion.options && motion.options.length > 0 ? ` (${motion.options.length} options)` : ""}`}
          </span>
        )}
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
            {isEditable && total > 1 && (
              <>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  aria-label={`Move ${motion.title} to top`}
                  onClick={onMoveTop}
                  disabled={isFirst || isReorderPending}
                >
                  &#x2912;
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  aria-label={`Move ${motion.title} to bottom`}
                  onClick={onMoveBottom}
                  disabled={isLast || isReorderPending}
                >
                  &#x2913;
                </button>
              </>
            )}
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
    motions.some(
      (m, i) =>
        m.id !== localOrder[i]?.id ||
        m.display_order !== localOrder[i]?.display_order ||
        m.is_visible !== localOrder[i]?.is_visible ||
        m.title !== localOrder[i]?.title ||
        m.description !== localOrder[i]?.description ||
        m.motion_type !== localOrder[i]?.motion_type ||
        m.motion_number !== localOrder[i]?.motion_number ||
        m.option_limit !== localOrder[i]?.option_limit ||
        JSON.stringify(m.options) !== JSON.stringify(localOrder[i]?.options)
    )
  ) {
    setLocalOrder(motions);
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
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

  // Build a lookup map from the authoritative `motions` prop so that
  // volatile fields (is_visible, title, description, motion_type, motion_number)
  // always reflect the latest React Query cache, even during the render cycle
  // where `localOrder` has not yet been synced (e.g. during optimistic visibility updates).
  const motionsPropMap = new Map(motions.map((m) => [m.id, m]));

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
                {localOrder.map((motion, index) => {
                  // Merge latest prop data (is_visible etc.) over the localOrder entry
                  // so optimistic cache updates propagate immediately without waiting
                  // for the localOrder sync check to trigger another render.
                  const latestMotion = motionsPropMap.get(motion.id) ?? motion;
                  return (
                    <SortableRow
                      key={motion.id}
                      motion={latestMotion}
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
                      onMoveBottom={() => moveItem(index, localOrder.length - 1)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
