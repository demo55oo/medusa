import { Router } from "express"
import { BatchJob } from "../../../.."
import { DeleteResponse, PaginatedResponse } from "../../../../types/common"
import middlewares from "../../../middlewares"

export default (app) => {
  const route = Router()

  app.use("/batch", route)

  route.get(
    "/",
    middlewares.normalizeQuery(),
    middlewares.wrap(require("./list-batch-jobs").default)
  )
  return app
}

export type AdminBatchJobRes = {
  batch_job: BatchJob
}

export type AdminBatchJobDeleteRes = DeleteResponse

export type AdminBatchJobListRes = PaginatedResponse & {
  batch_jobs: BatchJob[]
}

export const defaultAdminBatchFields = [
  "id",
  "status",
  "type",
  "context",
  "result",
  "created_by",
  "created_at",
  "updated_at",
  "deleted_at",
]

export * from "./list-batch-jobs"
