import { promises as fs } from "fs";
import puppeteer from "puppeteer-extra";
import { Browser, Page } from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { getConversations } from "./listConversations";
import { login } from "./login";
import { loadDoneFile, saveDoneFile, sleep } from "./utils";

export interface ExportLibraryOptions {
  outputDir: string;
  doneFilePath: string;
  email: string;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);
}

async function extractThreadContent(page: Page): Promise<{ title: string; markdown: string } | null> {
  return page.evaluate(() => {
    // Helper: convert HTML element to Markdown
    function htmlToMd(el: Element): string {
      let md = "";
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          md += node.textContent || "";
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const elem = node as Element;
          const tag = elem.tagName;

          // Skip citation number spans
          if (elem.classList.contains("citation") || elem.classList.contains("citation-nbsp")) {
            continue;
          }

          if (tag === "P") {
            md += "\n\n" + htmlToMd(elem);
          } else if (tag === "STRONG" || tag === "B") {
            md += "**" + htmlToMd(elem) + "**";
          } else if (tag === "EM" || tag === "I") {
            md += "*" + htmlToMd(elem) + "*";
          } else if (tag === "CODE") {
            const text = elem.textContent || "";
            if (elem.parentElement?.tagName === "PRE") {
              md += text;
            } else {
              md += "`" + text + "`";
            }
          } else if (tag === "PRE") {
            const code = elem.querySelector("code");
            const lang = code?.className?.match(/language-(\w+)/)?.[1] || "";
            md += "\n\n```" + lang + "\n" + (code?.textContent || elem.textContent || "") + "\n```\n";
          } else if (tag === "H1") {
            md += "\n\n# " + htmlToMd(elem);
          } else if (tag === "H2") {
            md += "\n\n## " + htmlToMd(elem);
          } else if (tag === "H3") {
            md += "\n\n### " + htmlToMd(elem);
          } else if (tag === "H4") {
            md += "\n\n#### " + htmlToMd(elem);
          } else if (tag === "UL") {
            md += "\n";
            for (const li of Array.from(elem.children)) {
              if (li.tagName === "LI") {
                md += "\n- " + htmlToMd(li).trim();
              }
            }
            md += "\n";
          } else if (tag === "OL") {
            md += "\n";
            let i = 1;
            for (const li of Array.from(elem.children)) {
              if (li.tagName === "LI") {
                md += "\n" + i + ". " + htmlToMd(li).trim();
                i++;
              }
            }
            md += "\n";
          } else if (tag === "A") {
            const href = (elem as HTMLAnchorElement).href;
            const text = htmlToMd(elem);
            md += "[" + text + "](" + href + ")";
          } else if (tag === "BR") {
            md += "\n";
          } else if (tag === "BLOCKQUOTE") {
            const inner = htmlToMd(elem).trim().split("\n").map((l: string) => "> " + l).join("\n");
            md += "\n\n" + inner + "\n";
          } else if (tag === "TABLE") {
            // Simple table extraction
            const rows = Array.from(elem.querySelectorAll("tr"));
            if (rows.length > 0) {
              md += "\n\n";
              rows.forEach((row, idx) => {
                const cells = Array.from(row.querySelectorAll("th, td"));
                md += "| " + cells.map((c) => (c.textContent || "").trim()).join(" | ") + " |\n";
                if (idx === 0) {
                  md += "| " + cells.map(() => "---").join(" | ") + " |\n";
                }
              });
            }
          } else {
            // Default: recurse
            md += htmlToMd(elem);
          }
        }
      }
      return md;
    }

    // Find all Q&A pairs on the page
    // The page structure has the query text and then prose blocks for answers
    const proseBlocks = Array.from(
      document.querySelectorAll(".prose")
    ).filter((el) => el.textContent && el.textContent.trim().length > 50);

    if (proseBlocks.length === 0) return null;

    // Get the page title / query from the page
    // Usually visible as a heading or the first prominent text
    const titleEl = document.querySelector("h1") ||
      document.querySelector('[class*="query"]') ||
      document.querySelector("title");
    const title = titleEl?.textContent?.trim() || document.title || "Untitled";

    // Build markdown from all prose blocks
    let fullMd = "# " + title + "\n\n";
    fullMd += "Source: " + window.location.href + "\n\n---\n";

    for (const block of proseBlocks) {
      const content = htmlToMd(block).trim();
      if (content) {
        fullMd += "\n\n" + content;
      }
    }

    // Clean up multiple newlines
    fullMd = fullMd.replace(/\n{4,}/g, "\n\n\n");

    return { title, markdown: fullMd };
  });
}

export default async function exportLibrary(options: ExportLibraryOptions) {
  puppeteer.use(StealthPlugin());

  await fs.mkdir(options.outputDir, { recursive: true });

  const doneFile = await loadDoneFile(options.doneFilePath);
  console.log(
    `Loaded ${doneFile.processedUrls.length} processed URLs from done file`
  );

  const browser: Browser = await puppeteer.launch({
    headless: false,
  });

  try {
    const page = await browser.newPage();

    await login(page, options.email);
    const conversations = await getConversations(page, doneFile);

    console.log(`Found ${conversations.length} new conversations to process`);

    let exported = 0;
    let failed = 0;

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      console.log(
        `[${i + 1}/${conversations.length}] ${conv.title.substring(0, 60)}`
      );

      try {
        await page.goto(conv.url, { waitUntil: "networkidle2", timeout: 30000 });
        // Wait for prose content to appear
        await page.waitForSelector(".prose", { timeout: 15000 });
        // Extra time for full render
        await sleep(1500);

        const result = await extractThreadContent(page);

        if (result && result.markdown.length > 0) {
          const filename = sanitizeFilename(conv.title || `thread-${i + 1}`) + ".md";
          await fs.writeFile(
            `${options.outputDir}/${filename}`,
            result.markdown,
            "utf-8"
          );
          exported++;
          console.log(`  ✓ Saved: ${filename}`);
        } else {
          failed++;
          console.log(`  ✗ No content extracted`);
        }

        doneFile.processedUrls.push(conv.url);
        await saveDoneFile(doneFile, options.doneFilePath);
      } catch (error) {
        failed++;
        console.error(`  ✗ Error: ${error}`);
        doneFile.processedUrls.push(conv.url);
        await saveDoneFile(doneFile, options.doneFilePath);
      }

      await sleep(2000);
    }

    console.log(
      `\nDone! Exported: ${exported}/${conversations.length}. Failed: ${failed}`
    );
  } catch (error) {
    console.error("An error occurred:", error);
  } finally {
    await browser.close();
  }
}
