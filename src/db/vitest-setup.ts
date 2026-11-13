import { enableProjectIdGuard } from "./guard.js";

// テストでは、ProjectDb の文に project_id が無いと投げる(別のプロジェクトの行へ触る書き忘れを落とす)
enableProjectIdGuard();
