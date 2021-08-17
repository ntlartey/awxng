import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { t } from '@lingui/macro';
import styled from 'styled-components';
import { CellMeasurerCache } from 'react-virtualized';
import { Button } from '@patternfly/react-core';

import AlertModal from 'components/AlertModal';
import { CardBody as _CardBody } from 'components/Card';
import ContentError from 'components/ContentError';
import ErrorDetail from 'components/ErrorDetail';
import StatusIcon from 'components/StatusIcon';

import { getJobModel, isJobRunning } from 'util/jobs';
import useRequest, { useDismissableError } from 'hooks/useRequest';
import useInterval from 'hooks/useInterval';
import { parseQueryString, getQSConfig } from 'util/qs';
import useIsMounted from 'hooks/useIsMounted';
import JobOutputPane from './JobOutputPane';
import { HostStatusBar, OutputToolbar } from './shared';
import getRowRangePageSize from './shared/jobOutputUtils';
import getLineTextHtml from './getLineTextHtml';

const QS_CONFIG = getQSConfig('job_output', {
  order_by: 'counter',
});

const CardBody = styled(_CardBody)`
  display: flex;
  flex-flow: column;
  height: calc(100vh - 267px);
`;

const HeaderTitle = styled.div`
  display: inline-flex;
  align-items: center;
  h1 {
    margin-left: 10px;
    font-weight: var(--pf-global--FontWeight--bold);
  }
`;

const OutputHeader = styled.div`
  display: flex;
  justify-content: space-between;
`;

let ws;
function connectJobSocket({ type, id }, onMessage) {
  ws = new WebSocket(
    `${window.location.protocol === 'http:' ? 'ws:' : 'wss:'}//${
      window.location.host
    }/websocket/`
  );

  ws.onopen = () => {
    const xrftoken = `; ${document.cookie}`
      .split('; csrftoken=')
      .pop()
      .split(';')
      .shift();
    const eventGroup = `${type}_events`;
    ws.send(
      JSON.stringify({
        xrftoken,
        groups: { jobs: ['summary', 'status_changed'], [eventGroup]: [id] },
      })
    );
  };

  ws.onmessage = (e) => {
    onMessage(JSON.parse(e.data));
  };

  ws.onclose = (e) => {
    if (e.code !== 1000) {
      // eslint-disable-next-line no-console
      console.debug('Socket closed. Reconnecting...', e);
      setTimeout(() => {
        connectJobSocket({ type, id }, onMessage);
      }, 1000);
    }
  };

  ws.onerror = (err) => {
    // eslint-disable-next-line no-console
    console.debug('Socket error: ', err, 'Disconnecting...');
    ws.close();
  };
}

function range(low, high) {
  const numbers = [];
  for (let n = low; n <= high; n++) {
    numbers.push(n);
  }
  return numbers;
}

const cache = new CellMeasurerCache({
  fixedWidth: true,
  defaultHeight: 25,
});

const getEventRequestParams = (job, remoteRowCount, requestRange) => {
  const [startIndex, stopIndex] = requestRange;
  if (isJobRunning(job?.status)) {
    return [
      { counter__gte: startIndex, limit: stopIndex - startIndex + 1 },
      range(startIndex, Math.min(stopIndex, remoteRowCount)),
      startIndex,
    ];
  }
  const { page, pageSize, firstIndex } = getRowRangePageSize(
    startIndex,
    stopIndex
  );
  const loadRange = range(
    firstIndex,
    Math.min(firstIndex + pageSize, remoteRowCount)
  );

  return [{ page, page_size: pageSize }, loadRange, firstIndex];
};

function JobOutput({ job, eventRelatedSearchableKeys, eventSearchableKeys }) {
  const location = useLocation();
  const listRef = useRef(null);
  const jobSocketCounter = useRef(0);
  const isMounted = useIsMounted();
  const history = useHistory();
  const [contentError, setContentError] = useState(null);
  const [cssMap, setCssMap] = useState({});
  const [currentlyLoading, setCurrentlyLoading] = useState([]);
  const [hasContentLoading, setHasContentLoading] = useState(true);
  const [jobStatus, setJobStatus] = useState(job.status ?? 'waiting');
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [remoteRowCount, setRemoteRowCount] = useState(0);
  const [results, setResults] = useState({});
  const [isFollowModeEnabled, setIsFollowModeEnabled] = useState(
    isJobRunning(job.status)
  );
  const [isMonitoringWebsocket, setIsMonitoringWebsocket] = useState(false);

  useInterval(
    () => {
      monitorJobSocketCounter();
    },
    isMonitoringWebsocket ? 5000 : null
  );

  // A
  useEffect(() => {
    loadJobEvents();

    if (isJobRunning(job.status)) {
      connectJobSocket(job, (data) => {
        if (data.group_name === 'job_events') {
          if (data.counter && data.counter > jobSocketCounter.current) {
            jobSocketCounter.current = data.counter;
          }
        }
        if (data.group_name === 'jobs' && data.unified_job_id === job.id) {
          if (data.final_counter) {
            jobSocketCounter.current = data.final_counter;
          }
          if (data.status) {
            setJobStatus(data.status);
          }
        }
      });
      setIsMonitoringWebsocket(true);
    }

    return function cleanup() {
      if (ws) {
        ws.close();
      }
      setIsMonitoringWebsocket(false);
      isMounted.current = false;
    };
  }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // B
  useEffect(() => {
    if (listRef.current?.recomputeRowHeights) {
      listRef.current.recomputeRowHeights();
    }
  }, [currentlyLoading, cssMap, remoteRowCount]);

  // C
  useEffect(() => {
    if (jobStatus && !isJobRunning(jobStatus)) {
      if (jobSocketCounter.current > remoteRowCount && isMounted.current) {
        setRemoteRowCount(jobSocketCounter.current);
      }

      if (isMonitoringWebsocket) {
        setIsMonitoringWebsocket(false);
      }

      if (isFollowModeEnabled) {
        setTimeout(() => setIsFollowModeEnabled(false), 1000);
      }
    }
  }, [jobStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const {
    error: cancelError,
    isLoading: isCancelling,
    request: cancelJob,
  } = useRequest(
    useCallback(async () => {
      await getJobModel(job.type).cancel(job.id);
    }, [job.id, job.type]),
    {}
  );

  const { error: dismissableCancelError, dismissError: dismissCancelError } =
    useDismissableError(cancelError);

  const {
    request: deleteJob,
    isLoading: isDeleting,
    error: deleteError,
  } = useRequest(
    useCallback(async () => {
      await getJobModel(job.type).destroy(job.id);

      history.push('/jobs');
    }, [job.type, job.id, history])
  );

  const { error: dismissableDeleteError, dismissError: dismissDeleteError } =
    useDismissableError(deleteError);

  const monitorJobSocketCounter = () => {
    if (jobSocketCounter.current > remoteRowCount && isMounted.current) {
      setRemoteRowCount(jobSocketCounter.current);
    }
    if (
      jobSocketCounter.current === remoteRowCount &&
      !isJobRunning(job.status)
    ) {
      setIsMonitoringWebsocket(false);
    }
  };

  const loadJobEvents = async () => {
    const [params, loadRange] = getEventRequestParams(job, 50, [1, 50]);

    if (isMounted.current) {
      setHasContentLoading(true);
      setCurrentlyLoading((prevCurrentlyLoading) =>
        prevCurrentlyLoading.concat(loadRange)
      );
    }

    const eventPromise = getJobModel(job.type).readEvents(job.id, {
      ...params,
      ...parseQueryString(QS_CONFIG, location.search),
    });

    let countRequest;
    if (isJobRunning(job?.status)) {
      // If the job is running, it means we're using limit-offset pagination. Requests
      // with limit-offset pagination won't return a total event count for performance
      // reasons. In this situation, we derive the remote row count by using the highest
      // counter available in the database.
      countRequest = async () => {
        const {
          data: { results: lastEvents = [] },
        } = await getJobModel(job.type).readEvents(job.id, {
          order_by: '-counter',
          limit: 1,
        });
        return lastEvents.length >= 1 ? lastEvents[0].counter : 0;
      };
    } else {
      countRequest = async () => {
        const {
          data: { count: eventCount },
        } = await eventPromise;
        return eventCount;
      };
    }

    try {
      const [
        {
          data: { results: fetchedEvents = [] },
        },
        count,
      ] = await Promise.all([eventPromise, countRequest()]);

      if (isMounted.current) {
        let countOffset = 0;
        if (job?.result_traceback) {
          const tracebackEvent = {
            counter: 1,
            created: null,
            event: null,
            type: null,
            stdout: job?.result_traceback,
            start_line: 0,
          };
          const firstIndex = fetchedEvents.findIndex(
            (jobEvent) => jobEvent.counter === 1
          );
          if (firstIndex && fetchedEvents[firstIndex]?.stdout) {
            const stdoutLines = fetchedEvents[firstIndex].stdout.split('\r\n');
            stdoutLines[0] = tracebackEvent.stdout;
            fetchedEvents[firstIndex].stdout = stdoutLines.join('\r\n');
          } else {
            countOffset += 1;
            fetchedEvents.unshift(tracebackEvent);
          }
        }

        const newResults = {};
        let newResultsCssMap = {};
        fetchedEvents.forEach((jobEvent, index) => {
          newResults[index] = jobEvent;
          const { lineCssMap } = getLineTextHtml(jobEvent);
          newResultsCssMap = { ...newResultsCssMap, ...lineCssMap };
        });
        setResults(newResults);
        setRemoteRowCount(count + countOffset);
        setCssMap(newResultsCssMap);
      }
    } catch (err) {
      setContentError(err);
    } finally {
      if (isMounted.current) {
        setHasContentLoading(false);
        setCurrentlyLoading((prevCurrentlyLoading) =>
          prevCurrentlyLoading.filter((n) => !loadRange.includes(n))
        );
        loadRange.forEach((n) => {
          cache.clear(n);
        });
      }
    }
  };

  if (contentError) {
    return <ContentError error={contentError} />;
  }

  return (
    <>
      <CardBody>
        <OutputHeader>
          <HeaderTitle>
            <StatusIcon status={job.status} />
            <h1>{job.name}</h1>
          </HeaderTitle>
          <OutputToolbar
            job={job}
            jobStatus={jobStatus}
            onCancel={() => setShowCancelModal(true)}
            onDelete={deleteJob}
            isDeleteDisabled={isDeleting}
          />
        </OutputHeader>
        <HostStatusBar counts={job.host_status_counts} />
        <JobOutputPane
          qsConfig={QS_CONFIG}
          job={job}
          eventRelatedSearchableKeys={eventRelatedSearchableKeys}
          eventSearchableKeys={eventSearchableKeys}
          results={results}
          setResults={setResults}
          currentlyLoading={currentlyLoading}
          setCurrentlyLoading={setCurrentlyLoading}
          hasContentLoading={hasContentLoading}
          listRef={listRef}
          remoteRowCount={remoteRowCount}
          isFollowModeEnabled={isFollowModeEnabled}
          setIsFollowModeEnabled={setIsFollowModeEnabled}
          cache={cache}
          cssMap={cssMap}
          setCssMap={setCssMap}
          getEventRequestParams={getEventRequestParams}
        />
      </CardBody>
      {showCancelModal && isJobRunning(job.status) && (
        <AlertModal
          isOpen={showCancelModal}
          variant="danger"
          onClose={() => setShowCancelModal(false)}
          title={t`Cancel Job`}
          label={t`Cancel Job`}
          actions={[
            <Button
              id="cancel-job-confirm-button"
              key="delete"
              variant="danger"
              isDisabled={isCancelling}
              aria-label={t`Cancel job`}
              onClick={cancelJob}
            >
              {t`Cancel job`}
            </Button>,
            <Button
              id="cancel-job-return-button"
              key="cancel"
              variant="secondary"
              aria-label={t`Return`}
              onClick={() => setShowCancelModal(false)}
            >
              {t`Return`}
            </Button>,
          ]}
        >
          {t`Are you sure you want to submit the request to cancel this job?`}
        </AlertModal>
      )}
      {dismissableDeleteError && (
        <AlertModal
          isOpen={dismissableDeleteError}
          variant="danger"
          onClose={dismissDeleteError}
          title={t`Job Delete Error`}
          label={t`Job Delete Error`}
        >
          <ErrorDetail error={dismissableDeleteError} />
        </AlertModal>
      )}
      {dismissableCancelError && (
        <AlertModal
          isOpen={dismissableCancelError}
          variant="danger"
          onClose={dismissCancelError}
          title={t`Job Cancel Error`}
          label={t`Job Cancel Error`}
        >
          <ErrorDetail error={dismissableCancelError} />
        </AlertModal>
      )}
    </>
  );
}

export default JobOutput;
