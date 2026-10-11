import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import MarketingSite from "../client/src/components/MarketingSite";

const render = (cloudPlanAvailable: boolean) => renderToStaticMarkup(
  <MarketingSite page="pricing" signedIn={false} onNavigate={() => {}} platform="mac" downloadLinks={{}} cloudPlanAvailable={cloudPlanAvailable} />,
);

test("/pricing offers Cloud only when the server has its Stripe price", () => {
  const on = render(true);
  expect(on).toContain("Start with Cloud");
  expect(on).not.toContain("Coming soon");
  const off = render(false);
  expect(off).not.toContain("Start with Cloud");
  expect(off).toContain("Coming soon");
  expect(off).toContain("is-unavailable");
});
