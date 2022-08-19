import ChartResultSet, { getSmartRs } from './chartResultSet';


test('ChartResultSet empty', () => {
  let crs = new ChartResultSet({tbl:{ data:[], types:{}}});
  expect(crs.rowTitle).toEqual("");
});


test('ChartResultSet num only', () => {
  let crs = new ChartResultSet({tbl:{ data:[{a:1}], types:{}}});
  expect(crs.numericColumns.length).toEqual(1);
  expect(crs.stringyColumns.length).toEqual(0);
});

test('ChartResultSet with 1 Stringy', () => {
  let crs = new ChartResultSet({tbl:{ data:[{b:"st", a:1},{b:"ar", a:2}], types:{}}});
  expect(crs.rowTitle).toEqual("b");
  expect(crs.numericColumns.length).toEqual(1);
  expect(crs.numericColumns[0].name).toEqual("a");
  expect(crs.numericColumns[0].vals).toEqual([1, 2]);
  expect(crs.stringyColumns.length).toEqual(1);
  expect(crs.stringyColumns[0].name).toEqual("b");
  expect(crs.stringyColumns[0].vals).toEqual(["st", "ar"]);
});

test('ChartResultSet with 2 Stringy', () => {
  let crs = new ChartResultSet({tbl:{ data:[{b:"st", a:1, c:"pop"},{b:"ar", a:2, c:"per"}], types:{}}});
  expect(crs.rowTitle).toEqual("b - c");
  expect(crs.numericColumns.length).toEqual(1);
  expect(crs.numericColumns[0].name).toEqual("a");
  expect(crs.numericColumns[0].vals).toEqual([1, 2]);
  expect(crs.stringyColumns.length).toEqual(2);
  expect(crs.stringyColumns[0].name).toEqual("b");
  expect(crs.stringyColumns[0].vals).toEqual(["st", "ar"]);
  expect(crs.rowLabels).toEqual(["st - pop", "ar - per"]);
});

test('getSmartRs', () => {
  let v = [4,5];
  let r = getSmartRs(["aa","bb"],[["row2","row2"],v]);
  expect((r.chartRS.numericColumns[0]).vals).toEqual(v);
});


test('ChartResultSet with numerics and nulls', () => {
  let crs = new ChartResultSet({tbl:{ data:[{a:1, b:null},{a:2, b:3}], types:{}}});
  const exp = "{\"numericColumns\":[{\"name\":\"a\",\"vals\":[1,2]},{\"name\":\"b\",\"vals\":[null,3]}],\"stringyColumns\":[],\"dateColumns\":[],\"rowLabels\":[],\"rowTitle\":\"\"}"
  expect(JSON.stringify(crs)).toEqual(exp);
});