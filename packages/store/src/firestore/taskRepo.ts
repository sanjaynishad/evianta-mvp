import { taskSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { StoreConflictError } from "../errors.js";
import { applyTaskUpdate } from "../mutations.js";
import type { TaskRepo } from "../types.js";
import {
  caseSubcollection,
  createDocAsync,
  isAlreadyExistsError,
  listInInsertionOrderAsync,
  mutateDocAsync,
  nextOrder,
  orderField,
  toFirestoreData,
} from "./helpers.js";

export function createTaskRepo(db: Firestore): TaskRepo {
  return {
    async createTaskAsync(input) {
      const task = taskSchema.parse(input);

      await createDocAsync(caseSubcollection(db, task.caseId, "tasks").doc(task.id), task, "task");

      return task;
    },
    async createTasksAsync(caseId, inputs) {
      const tasks = inputs.map((input) => taskSchema.parse(input));
      const ids = new Set<string>();
      const batch = db.batch();

      for (const task of tasks) {
        if (task.caseId !== caseId) {
          throw new Error(`Task "${task.id}" does not belong to case "${caseId}".`);
        }

        if (ids.has(task.id)) {
          throw new StoreConflictError("task", task.id);
        }

        ids.add(task.id);
        batch.create(
          caseSubcollection(db, caseId, "tasks").doc(task.id),
          toFirestoreData({ ...task, [orderField]: nextOrder() }),
        );
      }

      try {
        await batch.commit();
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new StoreConflictError("task", tasks.map((task) => task.id).join(", "));
        }

        throw error;
      }

      return tasks;
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
