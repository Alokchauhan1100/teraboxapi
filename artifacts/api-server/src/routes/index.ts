import { Router, type IRouter } from "express";
import healthRouter from "./health";
import teraboxRouter from "./terabox";

const router: IRouter = Router();

router.use(healthRouter);
router.use(teraboxRouter);

export default router;
