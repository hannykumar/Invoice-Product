/**
 * Issue #147 wired into the running app — searching for the mark of a trade.
 *
 * A business types what it sells and gets back drawings it can look at. The screen that shows them
 * belongs to the web app (issue #146 owns picture upload); everything it needs is here: the search,
 * the drawing to show in the list, and the finished choice to store once somebody picks one.
 *
 * Nothing here decides anything for a business. An empty search returns an empty list rather than a
 * suggestion, and no picture is ever attached to a company that did not ask for it.
 */
import {
  MAX_TRADE_MARK_OPACITY_PERCENT,
  searchTradeMarks,
  tradeMarkFromLibrary,
  tradeMarkSvg,
  type TradeMarkChoice,
} from '@invoice/invoice-templates';

const str = (value: unknown): string => String(value ?? '').trim();

export interface TradeMarkSuggestion {
  readonly pictureId: string;
  /** The drawing itself, ready to put straight into the page that lists the choices. */
  readonly svg: string;
}

/**
 * The pictures that answer what a business typed.
 *
 * The drawing comes back at full strength, because this is the list somebody is choosing from and
 * choosing between six faint smudges is not choosing. The faintness applies to the bill, not here.
 */
export const searchMarks = (body: unknown): { readonly query: string; readonly pictures: readonly TradeMarkSuggestion[] } => {
  const input = (body ?? {}) as { query?: unknown; limit?: unknown };
  const query = str(input.query);
  const limit = Math.min(Math.max(Number(input.limit ?? 24) || 24, 1), 60);
  return {
    query,
    pictures: searchTradeMarks(query, limit).map((r) => ({
      pictureId: r.picture.id,
      svg: tradeMarkSvg(r.picture, '#1f2933'),
    })),
  };
};

/**
 * The choice a business has made, in the form that is stored against it and frozen onto its bills.
 *
 * The cap on faintness is applied by the module rather than trusted from the request: a screen can
 * ask for anything, and the thing under the watermark is the tax on the bill.
 */
export const chooseMark = (body: unknown): { readonly tradeMark: TradeMarkChoice; readonly maxOpacityPercent: number } => {
  const input = (body ?? {}) as { pictureId?: unknown; opacityPercent?: unknown };
  const asked = Number(input.opacityPercent ?? MAX_TRADE_MARK_OPACITY_PERCENT);
  const opacity = Number.isFinite(asked) ? Math.min(asked, MAX_TRADE_MARK_OPACITY_PERCENT) : MAX_TRADE_MARK_OPACITY_PERCENT;
  return {
    tradeMark: tradeMarkFromLibrary(str(input.pictureId), opacity),
    maxOpacityPercent: MAX_TRADE_MARK_OPACITY_PERCENT,
  };
};
