// Raw byte passthrough endpoint (/api/fetch/raw). Separate function so the
// pretty redirect preserves the caller's ?url= param while forcing raw mode.
import handler from "./fetch";

export default async (req: Request, context: unknown): Promise<Response> => {
  const u = new URL(req.url);
  u.searchParams.set("mode", "raw");
  return handler(new Request(u.toString(), req), context as never);
};

export const config = { path: "/api/fetch/raw" };
