import { Page } from "puppeteer";
import { Conversation, DoneFile } from "./types";
import { sleep } from "./utils";

export async function scrollToBottomOfConversations(
  page: Page,
  doneFile: DoneFile
): Promise<void> {
  // Find the scrollable container for the library
  const containerSelector = await page.evaluate(() => {
    // Try multiple possible scrollable containers
    const candidates = Array.from(document.querySelectorAll("div")).filter((d) => {
      const style = window.getComputedStyle(d);
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        d.scrollHeight > d.clientHeight
      );
    });
    // Return the one that contains thread links
    for (const c of candidates) {
      if (c.querySelector('a[href*="/search/"]')) {
        // Mark it for later use
        c.setAttribute("data-perplexport-scroll", "true");
        return true;
      }
    }
    return false;
  });

  if (!containerSelector) {
    console.log("Warning: Could not find scrollable container with threads");
    return;
  }

  let previousHeight = 0;
  let currentHeight = await page.evaluate(() => {
    const container = document.querySelector('[data-perplexport-scroll="true"]');
    return container?.scrollHeight || 0;
  });

  let scrollAttempts = 0;
  const maxScrollAttempts = 100; // safety limit

  while (previousHeight !== currentHeight && scrollAttempts < maxScrollAttempts) {
    scrollAttempts++;

    // Check if we've hit any processed URLs
    const foundProcessed = await page.evaluate((processedUrls) => {
      const items = Array.from(document.querySelectorAll('a[href*="/search/"]'));
      return items.some((item) => processedUrls.includes((item as HTMLAnchorElement).href));
    }, doneFile.processedUrls);

    if (foundProcessed) {
      console.log("Found already processed conversation, stopping scroll");
      break;
    }

    // Scroll to bottom
    await page.evaluate(() => {
      const container = document.querySelector('[data-perplexport-scroll="true"]');
      if (container) {
        container.scrollTo(0, container.scrollHeight);
      }
    });

    await sleep(2000);

    previousHeight = currentHeight;
    currentHeight = await page.evaluate(() => {
      const container = document.querySelector('[data-perplexport-scroll="true"]');
      return container?.scrollHeight || 0;
    });

    if (scrollAttempts % 10 === 0) {
      const count = await page.evaluate(
        () => document.querySelectorAll('a[href*="/search/"]').length
      );
      console.log(`Scrolling... found ${count} threads so far`);
    }
  }
}

export async function getConversations(
  page: Page,
  doneFile: DoneFile
): Promise<Conversation[]> {
  // We're already on /library from the login step
  // Just make sure threads are visible
  console.log("Reading library threads...");

  await page.waitForSelector('a[href*="/search/"]', { timeout: 30000 });
  await scrollToBottomOfConversations(page, doneFile);

  // Get all conversation links
  const conversations = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('a[href*="/search/"]'));
    // Deduplicate by href
    const seen = new Set<string>();
    return items
      .filter((item) => {
        const href = (item as HTMLAnchorElement).href;
        if (seen.has(href)) return false;
        seen.add(href);
        return true;
      })
      .map((item) => ({
        title: item.textContent?.trim() || "Untitled",
        url: (item as HTMLAnchorElement).href,
      }));
  });

  // Filter out already processed conversations and reverse the order
  return conversations
    .filter((conv) => !doneFile.processedUrls.includes(conv.url))
    .reverse();
}
