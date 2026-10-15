import { expect, test } from "@playwright/test";

// A diagram is rendered once the SDK's canvas reports a finished layout.
const canvas = "[data-layout-ready]";

test("the site opens on the current system context and lays it out", async ({ page }) => {
  await page.goto("./");
  await expect(page).toHaveURL(
    /#\/architectures\/tsdb-current\/diagrams\/context$/,
  );
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "System context: Document DB platform",
    }),
  ).toBeVisible();
  await expect(page.locator(canvas)).toHaveCount(1);
  await expect(
    page.getByRole("navigation", { name: "View mode" }).getByRole("link", {
      name: "Current",
    }),
  )
    .toHaveAttribute("aria-current", "page");
});

test("side by side renders the current and the proposed context as two canvases", async ({ page }) => {
  await page.goto("./#/compare/context/lanes-context");
  await expect(page.locator(canvas)).toHaveCount(2);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "System context: Document DB platform",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "System context: proposed statement lanes and placement",
    }),
  )
    .toBeVisible();
});

test("drilling down in one side-by-side pane is recorded in the URL and survives a reload", async ({ page }) => {
  await page.goto("./#/compare/context/lanes-context");
  await expect(page.locator(canvas)).toHaveCount(2);
  // Open the proposed platform's container view from the right-hand pane's canvas only.
  const proposedPane = page.getByRole("region", { name: /^Proposed/ });
  await proposedPane.locator(
    `${canvas} >> role=link[name="Open detail for Document DB platform"]`,
  ).click();
  await expect(page).toHaveURL(/#\/compare\/context\/lanes-containers$/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "System context: Document DB platform",
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Containers: proposed data node with statement lanes",
    }),
  )
    .toBeVisible();
  await expect(page.locator(canvas)).toHaveCount(2);
  // The level links pair the same C4 level on both sides.
  await page.getByRole("navigation", { name: "C4 level" }).getByRole("link", {
    name: "Containers",
  }).click();
  await expect(page).toHaveURL(
    /#\/compare\/containers-platform\/lanes-containers$/,
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Containers: request path" }),
  ).toBeVisible();
});

test("a deep link to a proposed diagram reloads to the same diagram", async ({ page }) => {
  await page.goto(
    "./#/architectures/tsdb-lanes-proposal/diagrams/lanes-containers",
  );
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Containers: proposed data node with statement lanes",
    }),
  )
    .toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Containers: proposed data node with statement lanes",
    }),
  )
    .toBeVisible();
  await expect(page.locator(canvas)).toHaveCount(1);
});

test("unknown routes show Not Found instead of falling back", async ({ page }) => {
  await page.goto("./#/architectures/nope/diagrams/context");
  await expect(page.getByRole("heading", { name: "Not Found" })).toBeVisible();
  await page.goto("./#/compare/context/no-such-diagram");
  await expect(page.getByRole("heading", { name: "Not Found" })).toBeVisible();
  await page.goto("./#/architectures/tsdb-current/diagrams/no-such-diagram");
  await expect(page.getByText(/Not Found: unknown diagram/)).toBeVisible();
});

test("mode links and the skip link are keyboard reachable", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator(canvas)).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to the diagrams" }))
    .toBeFocused();
  const proposed = page.getByRole("navigation", { name: "View mode" })
    .getByRole("link", { name: "Proposed" });
  await proposed.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    /#\/architectures\/tsdb-lanes-proposal\/diagrams\/lanes-context$/,
  );
  await expect(page.locator(canvas)).toHaveCount(1);
});

test("side by side pairs the current server components with the proposed lane components", async ({ page }) => {
  await page.goto("./#/compare/context/lanes-context");
  await expect(page.locator(canvas)).toHaveCount(2);
  await page.getByRole("navigation", { name: "C4 level" }).getByRole("link", {
    name: "Components",
  }).click();
  await expect(page).toHaveURL(/#\/compare\/components-server\/lanes-components$/);
  await expect(page.locator(canvas)).toHaveCount(2);
  await expect(
    page.getByRole("heading", { level: 1, name: "Components: proposed statement lane process" }),
  ).toBeVisible();
});

// One view of each kind PG-02 added; each must lay out on its own canvas.
for (
  const [architecture, diagram, title] of [
    ["tsdb-current", "landscape", "System landscape: ts-db, its people and its neighbours"],
    ["tsdb-current", "code-document-reader", "Code: platform/document_reader.ts"],
    [
      "tsdb-lanes-proposal",
      "flow-long-query-interrupt",
      "Flow: a long query stopped at its deadline (proposed)",
    ],
    [
      "tsdb-lanes-proposal",
      "lanes-deployment",
      "Deployment (illustrative): two data nodes with statement lanes",
    ],
  ]
) {
  test(`the ${diagram} view renders`, async ({ page }) => {
    await page.goto(`./#/architectures/${architecture}/diagrams/${diagram}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator(canvas)).toHaveCount(1);
  });
}
