import winston from 'winston';
import {Properties} from '../../../src/sn/amb/Properties';
import {Logger} from '../../../src/util/Logger';
import { Mock, mock } from 'ts-jest-mocker';

describe.skip('Logger', () => {
	it.skip('legacy test - broken', () => {});
	const outputMessage:string = '';
	let mockLogger:any; 
	// beforeEach(() => {
	// 	outputMessage = "";
	// 	mockLogger = mock(winston.Logger);
	// 	mockLogger.debug.mockImplementation((m:object):winston.Logger => {
	// 		outputMessage = m as String;
	// 		return mockLogger;
	// 	});
	// 	mockLogger.info.mockImplementation((m:object):winston.Logger => {
	// 		outputMessage = m as String;
	// 		return mockLogger;
	// 	});
	// 	mockLogger.warn.mockImplementation((m:object):winston.Logger => {
	// 		outputMessage = m as String;
	// 		return mockLogger;
	// 	});
	// 	mockLogger.error.mockImplementation((m:object):winston.Logger => {
	// 		outputMessage = m as String;
	// 		return mockLogger;
	// 	});


	// });

	
	

	// it('logs info message to console', () => {
	// 	const logger = new Logger('test logger');
	// 	logger.setLogger(mockLogger);
	// 	logger.addInfoMessage('info');
	// 	expect(outputMessage).toBe('info');
	// });

	// it('logs error message to console', () => {
	// 	const logger = new Logger('test logger');
	// 	logger.setLogger(mockLogger);
	// 	logger.addErrorMessage('error');
	// 	expect(outputMessage).toBe('error');
	// });

	// it('logs debug message if logLevel is debug ', () => {
	// 	//Properties.instance.logLevel = 'debug';
	// 	const logger = new Logger('test logger');
	// 	logger.setLogger(mockLogger);
	// 	logger.debug("debug");
	// 	expect(outputMessage).toBe('debug');
	// });

	
});
