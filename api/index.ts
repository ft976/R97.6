import { createExpressApp } from "../server";

export default async function handler(req: any, res: any) {
  const app = await createExpressApp();
  return app(req, res);
}
