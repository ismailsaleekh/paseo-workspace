import { expect, test } from "vitest";
import {
  visualSidebarLayout,
  VISUAL_CHAT_LAYOUT,
  VISUAL_SIDEBAR_WIDE_LAYOUT,
} from "./sidebar-layout";

test("layout consumers reserve the wide dock and let retained chat shrink within the remaining space", () => {
  expect(VISUAL_CHAT_LAYOUT).toEqual({ minWidth: 0, flexBasis: 0, flexGrow: 1, flexShrink: 1 });
  expect(VISUAL_SIDEBAR_WIDE_LAYOUT).toEqual({
    width: 400,
    flexBasis: 400,
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
  });
});

test("wide drawing layout retains chat alongside, compact selects a dedicated destination", () => {
  expect(visualSidebarLayout(false, false)).toEqual({
    chatVisible: true,
    sidebarVisible: false,
    direction: "row",
  });
  expect(visualSidebarLayout(false, true)).toEqual({
    chatVisible: true,
    sidebarVisible: true,
    direction: "row",
  });
  expect(visualSidebarLayout(true, true)).toEqual({
    chatVisible: false,
    sidebarVisible: true,
    direction: "column",
  });
  expect(visualSidebarLayout(true, false)).toEqual({
    chatVisible: true,
    sidebarVisible: false,
    direction: "column",
  });
});

test("full screen shows only the drawing, on wide and compact screens, and only while open", () => {
  for (const compact of [false, true]) {
    expect(visualSidebarLayout(compact, true, true)).toEqual({
      chatVisible: false,
      sidebarVisible: true,
      direction: "column",
    });
    expect(visualSidebarLayout(compact, false, true)).toEqual(visualSidebarLayout(compact, false));
  }
});
