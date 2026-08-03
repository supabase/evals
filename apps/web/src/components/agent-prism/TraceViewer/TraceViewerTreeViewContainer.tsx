import type { TraceSpan } from "@evilmartians/agent-prism-types"
import { Badge } from "../Badge"
import type { SpanCardViewOptions } from "../SpanCard/SpanCard"
import { TraceListItemHeader } from "../TraceList/TraceListItemHeader"
import { TreeView } from "../TreeView"
import type { TraceRecordWithDisplayData } from "./TraceViewer"
import { TraceViewerSearchAndControls } from "./TraceViewerSearchAndControls"

export const TraceViewerTreeViewContainer = ({
  searchValue,
  setSearchValue,
  handleExpandAll,
  handleCollapseAll,
  filteredSpans,
  selectedSpan,
  setSelectedSpan,
  expandedSpansIds,
  setExpandedSpansIds,
  spanCardViewOptions,
  selectedTrace,
  showHeader = true,
}: {
  searchValue: string
  setSearchValue: (value: string) => void
  handleExpandAll: () => void
  handleCollapseAll: () => void
  filteredSpans: TraceSpan[]
  selectedSpan: TraceSpan | undefined
  setSelectedSpan: (span: TraceSpan | undefined) => void
  expandedSpansIds: string[]
  setExpandedSpansIds: (ids: string[]) => void
  spanCardViewOptions?: SpanCardViewOptions
  selectedTrace?: TraceRecordWithDisplayData
  showHeader?: boolean
}) => (
  <>
    {showHeader && selectedTrace && (
      <div className="flex shrink-0 flex-col gap-1 px-4">
        <TraceListItemHeader trace={selectedTrace} />

        {selectedTrace.badges && selectedTrace.badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-2">
            {selectedTrace.badges.map((badge, index) => (
              <Badge key={index} size="4" label={badge.label} />
            ))}
          </div>
        )}
      </div>
    )}

    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md bg-agentprism-background">
      <TraceViewerSearchAndControls
        searchValue={searchValue}
        setSearchValue={setSearchValue}
        handleExpandAll={handleExpandAll}
        handleCollapseAll={handleCollapseAll}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredSpans.length === 0 ? (
          <div className="p-3 text-center text-agentprism-muted-foreground">
            No spans found
          </div>
        ) : (
          <TreeView
            spans={filteredSpans}
            onSpanSelect={setSelectedSpan}
            selectedSpan={selectedSpan}
            expandedSpansIds={expandedSpansIds}
            onExpandSpansIdsChange={setExpandedSpansIds}
            spanCardViewOptions={spanCardViewOptions}
          />
        )}
      </div>
    </div>
  </>
)
