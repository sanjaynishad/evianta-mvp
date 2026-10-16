import { taskSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { applyTaskUpdate } from "../mutations.js";
import type { TaskRepo } from "../types.js";
import {
  caseSubcollection,
  createDocAsync,
  listInInsertionOrderAsync,
  mutateDocAsync,
} from "./helpers.js";

export function createTaskRepo(db: Firestore): TaskRepo {
  return {
    async createTaskAsync(input) {
      const task = taskSchema.parse(input);

      await createDocAsync(caseSubcollection(db, task.caseId, "tasks").doc(task.id), task, "task");

      return task;
    },
    async getTasksForCaseAsync(caseId) {
      return listInInsertionOrderAsync(caseSubcollection(db, caseId, "tasks"), taskSchema);
    },
    async updateTaskAsync(caseId, taskId, update) {
      return mutateDocAsync(
        db,
        caseSubcollection(db, caseId, "tasks").doc(taskId),
        taskSchema,
        "task",
        (current) => applyTaskUpdate(current, update),
      );
    },
  };
}
