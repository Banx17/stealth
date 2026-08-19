import { test, expect } from "./fixtures";

test.describe("Account Settings", () => {
  test.beforeEach(async ({ page, authenticate }) => {
    await authenticate();
    await page.goto("/mail");
  });

  test("can view and update profile settings", async ({ page }) => {
    // Open Settings modal
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // Verify initial profile data is loaded
    await expect(page.getByText("Alice User")).toBeVisible();
    await expect(page.getByText("alice@stealth.test")).toBeVisible();

    // Edit display name
    await page.getByRole("button", { name: "Edit Display name" }).click();
    const displayNameInput = page.getByPlaceholder("Not set").first();
    await displayNameInput.fill("Alice Updated");
    await page.getByRole("button", { name: "Save" }).click();

    // Verify optimistic update / persistence
    await expect(page.getByText("Alice Updated")).toBeVisible();

    // Check identifiers section
    await expect(page.getByText("Email changes require identity verification")).not.toBeVisible();
    await page.getByRole("button", { name: "Immutable" }).first().hover();
    await expect(page.getByText("Usernames cannot be changed")).toBeVisible();
  });
});
