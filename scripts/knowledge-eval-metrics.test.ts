import test from "node:test";
import assert from "node:assert/strict";
import { retrievalMetrics,percentile } from "./knowledge-eval-metrics";
test("召回率去重、MRR 与无答案分母",()=>{assert.deepEqual(retrievalMetrics(["a","b"],["x","a","a"]),{recall:0.5,mrr:0.5});assert.deepEqual(retrievalMetrics([],[]),{recall:null,mrr:null});assert.equal(percentile([9,1,2],0.5),2);assert.equal(percentile([],0.95),null);});
