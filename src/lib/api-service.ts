import {
  BatchCollectionRequest,
  CollectionFetchOptions,
  DatabaseRecord,
  fetchCollection,
  fetchCollectionByProgramme,
  fetchCollectionByProgrammes,
  fetchCollectionsBatch,
} from "@/lib/firebase";

export const apiService = {
  getCollection: <T = Record<string, any>>(
    path: string,
    options?: CollectionFetchOptions,
  ): Promise<DatabaseRecord<T>[]> =>
    fetchCollection<T>(path, options),

  getCollectionByProgramme: <T = Record<string, any>>(
    path: string,
    programme: string,
    options?: CollectionFetchOptions,
  ): Promise<DatabaseRecord<T>[]> =>
    fetchCollectionByProgramme<T>(path, programme, options),

  getCollectionByProgrammes: <T = Record<string, any>>(
    path: string,
    programmes: readonly string[],
    options?: CollectionFetchOptions,
  ): Promise<DatabaseRecord<T>[]> =>
    fetchCollectionByProgrammes<T>(path, programmes, options),

  getPaginatedCollection: <T = Record<string, any>>(
    path: string,
    page: number,
    limit: number,
    options?: CollectionFetchOptions,
  ): Promise<DatabaseRecord<T>[]> =>
    fetchCollection<T>(path, { ...options, fetchAll: false, page, limit }),

  getAllDatesCollection: <T = Record<string, any>>(
    path: string,
    options?: CollectionFetchOptions,
  ): Promise<DatabaseRecord<T>[]> =>
    fetchCollection<T>(path, { ...options, noDateFilter: true }),

  getPageData: <T = Record<string, any>>(
    requests: readonly BatchCollectionRequest[],
  ): Promise<Record<string, DatabaseRecord<T>[]>> =>
    fetchCollectionsBatch<T>(requests),
};
