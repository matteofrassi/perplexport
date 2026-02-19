import { Page } from "puppeteer";

export async function login(page: Page, email: string): Promise<void> {
  console.log("Navigating to Perplexity library...");
  console.log("A login modal will appear. Please log in manually.");
  console.log("Waiting up to 3 minutes for login to complete...");

  await page.goto("https://www.perplexity.ai/library");
  await new Promise((r) => setTimeout(r, 3000));

  const maxWait = 180000; // 3 minutes
  const pollInterval = 2000;
  let elapsed = 0;
  let loggedIn = false;

  while (elapsed < maxWait) {
    try {
      // Check current URL first — after OAuth redirect we may land back on library
      const currentUrl = page.url();

      // If we're on an OAuth page (Google, Apple), just wait
      if (
        currentUrl.includes("accounts.google") ||
        currentUrl.includes("appleid.apple.com")
      ) {
        await new Promise((r) => setTimeout(r, pollInterval));
        elapsed += pollInterval;
        continue;
      }

      // If we're back on Perplexity, check for threads
      if (currentUrl.includes("perplexity.ai")) {
        loggedIn = await page.evaluate(() => {
          const loginModal = document.querySelector('[data-testid="login-modal"]');
          if (loginModal) return false;
          const allLinks = Array.from(document.querySelectorAll("a"));
          return allLinks.some(
            (a) => a.href && a.href.includes("perplexity.ai/search/")
          );
        });
      }
    } catch {
      // Navigation destroyed context — this is expected during OAuth redirects
    }

    if (loggedIn) break;

    await new Promise((r) => setTimeout(r, pollInterval));
    elapsed += pollInterval;

    if (elapsed % 30000 === 0) {
      console.log(`Still waiting for login... (${elapsed / 1000}s elapsed)`);
    }
  }

  if (!loggedIn) {
    throw new Error("Login timed out after 3 minutes. Please try again.");
  }

  // Make sure we're on the library page after login
  const currentUrl = page.url();
  if (!currentUrl.includes("/library")) {
    await page.goto("https://www.perplexity.ai/library");
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log("Successfully logged in — threads detected in library");
}
