import { test } from '@japa/runner'
import { isReadOnlyStatement } from '#services/hosxp_client'

test.group('HOSxP read-only guard', () => {
  test('ยอมให้ SELECT ธรรมดาผ่าน', ({ assert }) => {
    assert.isTrue(isReadOnlyStatement('SELECT hn, cid FROM patient LIMIT 5'))
    assert.isTrue(isReadOnlyStatement('  select 1'))
    assert.isTrue(isReadOnlyStatement('SHOW TABLES'))
    assert.isTrue(isReadOnlyStatement('SHOW GRANTS FOR CURRENT_USER()'))
    assert.isTrue(isReadOnlyStatement('DESCRIBE ovst'))
    assert.isTrue(isReadOnlyStatement('EXPLAIN SELECT 1'))
    assert.isTrue(isReadOnlyStatement('WITH x AS (SELECT 1) SELECT * FROM x'))
  })

  test('ยอมให้คำสั่งเขียนที่อยู่ใน string literal ผ่าน', ({ assert }) => {
    // เคสนี้เคยพังจริง — blacklist เดิมจับคำว่า update ใน regex literal
    assert.isTrue(
      isReadOnlyStatement(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE COLUMN_NAME REGEXP '(date|time|update|modif|seq)'`
      )
    )
    assert.isTrue(isReadOnlyStatement(`SELECT 'insert into' AS note`))
    assert.isTrue(isReadOnlyStatement(`SELECT EXTRA FROM t WHERE EXTRA LIKE '%auto_increment%'`))
  })

  test('ปฏิเสธคำสั่งเขียน', ({ assert }) => {
    assert.isFalse(isReadOnlyStatement('INSERT INTO patient (hn) VALUES ("1")'))
    assert.isFalse(isReadOnlyStatement('UPDATE ovst SET vstdate = NOW()'))
    assert.isFalse(isReadOnlyStatement('DELETE FROM queue'))
    assert.isFalse(isReadOnlyStatement('DROP TABLE patient'))
    assert.isFalse(isReadOnlyStatement('TRUNCATE queue'))
    assert.isFalse(isReadOnlyStatement('ALTER TABLE patient ADD COLUMN x INT'))
    assert.isFalse(isReadOnlyStatement('CREATE TABLE t (id INT)'))
    assert.isFalse(isReadOnlyStatement('REPLACE INTO patient VALUES (1)'))
    assert.isFalse(isReadOnlyStatement('CALL some_procedure()'))
  })

  test('ปฏิเสธ SELECT ที่เขียนลงดิสก์', ({ assert }) => {
    assert.isFalse(isReadOnlyStatement(`SELECT * FROM patient INTO OUTFILE '/tmp/dump.csv'`))
    assert.isFalse(isReadOnlyStatement(`SELECT * FROM patient INTO DUMPFILE '/tmp/x'`))
  })

  test('ปฏิเสธคำสั่งเขียนที่ซ่อนหลัง comment', ({ assert }) => {
    assert.isFalse(isReadOnlyStatement('/* SELECT */ DELETE FROM patient'))
    assert.isFalse(isReadOnlyStatement('-- SELECT ok\nUPDATE patient SET hn = 1'))
    assert.isFalse(isReadOnlyStatement('# comment\nDROP TABLE patient'))
    assert.isFalse(isReadOnlyStatement('/* a */ /* b */ INSERT INTO t VALUES (1)'))
  })
})
