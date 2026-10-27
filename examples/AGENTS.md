# 项目说明（给 agent 看的）

这是一个 Spring Boot 3 后端服务，给内部的订单系统提供 REST 接口。

## 怎么构建和测试
- 构建：`mvnw.cmd -q package -DskipTests`
- 全部测试：`mvnw.cmd -q test`；单个测试：`mvnw.cmd -q test -Dtest=OrderServiceTest`
- 本地运行：`mvnw.cmd spring-boot:run -Dspring-boot.run.profiles=local`

## 目录
- `src/main/java/.../api`：控制器，只做参数校验和转换
- `src/main/java/.../service`：业务逻辑，所有事务边界在这一层
- `src/main/resources/db/migration`：Flyway 脚本，**只能新增，不能改已有的**

## 约定
- 金额一律用 `BigDecimal`，不要用 double
- 新接口要有对应的 `*ControllerTest`
- 提交信息用中文，格式：`模块: 做了什么`

## 容易踩的坑
- `application-local.yml` 里的数据库是共享测试库，不要在测试里清表
